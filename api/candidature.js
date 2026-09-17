// api/candidature.js — réception des candidatures (espace candidat).
//
// Un dépôt sur le site suit exactement le cheminement de l'upload « volume »
// du produit Swipelink (admin/upload-resumes) : fichier dans le bucket
// "resumes" (racine, uuid.ext), ligne Resume minimale { bucket_path,
// upload_mode: VOLUME, target_offer_id: null, source: SITE } — les défauts de
// la base posent ocr_state/llm_state = waiting et parsing_pipeline = main, et
// le trigger notify_ocr appelle lui-même l'event-manager. Le pipeline
// OCR → LLM parse le CV et crée le Candidat — rien d'autre à faire ici, et
// aucune table dédiée au site. En mode VOLUME, un CV dont le téléphone
// correspond à un candidat existant est ignoré par le pipeline (pas écrasé).
//
// Sécurité appliquée côté serveur (la seule qui fait foi) :
//   1. Honeypot : le champ caché "site_web" rempli => réponse succès factice, rien n'est stocké.
//   2. Cloudflare Turnstile : le jeton est vérifié avec la clé secrète (TURNSTILE_SECRET_KEY).
//   3. Limite par IP (5/h, en mémoire) + disjoncteur global (DAILY_CAP/24 h,
//      compté dans la base) : chaque dépôt coûte un passage OCR + LLM.
//   4. Validation stricte : champs bornés, fichier PDF/JPG/PNG uniquement, 4 Mo max,
//      type réel vérifié par les premiers octets (pas seulement l'extension).
//
// Configuration : voir docs/SETUP-CANDIDATURES.md.

const crypto = require('crypto');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const MAX_FILE = 4 * 1024 * 1024; // 4 Mo (le corps de requête Vercel est plafonné à 4,5 Mo)
const LIMIT_PER_HOUR = 5;
// Disjoncteur global : dépôts max sur 24 h, tous visiteurs confondus. Chaque
// dépôt déclenche un passage OCR + parsing LLM : le plafond borne le coût
// absolu si une attaque distribuée passait Turnstile. Réglable sans
// redéploiement via la variable Vercel DAILY_CAP.
const DAILY_CAP = parseInt(process.env.DAILY_CAP || '200', 10);
// Mêmes formats que l'upload volume du produit (SUPPORTED_MIME_TYPES).
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
};
// Clé secrète de TEST Cloudflare (accepte tout) tant que TURNSTILE_SECRET_KEY n'est pas configurée.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

function goodMagic(buf, ext) {
  if (buf.length < 8) return false;
  if (ext === 'pdf') return buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (ext === 'jpg') return buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (ext === 'png') return buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return false;
}

function validateFields(f) {
  const prenom = (f.prenom || '').trim();
  const nom = (f.nom || '').trim();
  const tel = (f.telephone || '').trim();
  const email = (f.email || '').trim();
  if (prenom.length < 2 || prenom.length > 60) return 'Prénom invalide.';
  if (nom.length < 2 || nom.length > 60) return 'Nom invalide.';
  const digits = tel.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15 || tel.length > 20) return 'Téléphone invalide.';
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return 'Email invalide.';
  return null;
}

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE, files: 1, fields: 10, fieldSize: 2048 },
    });
    const fields = {};
    let file = null;
    let truncated = false;
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('limit', () => { truncated = true; });
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { file = { name: info.filename || '', buf: Buffer.concat(chunks) }; });
    });
    bb.on('close', () => resolve({ fields, file, truncated }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function verifyTurnstile(token, ip) {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  // Fail closed : en production, pas de clé configurée = refus. La clé de TEST
  // (qui accepte tout) ne sert qu'en preview/développement.
  if (!secret && process.env.VERCEL_ENV === 'production') return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: secret || TURNSTILE_TEST_SECRET,
        response: token || '',
        remoteip: ip,
      }),
    });
    const d = await r.json();
    return !!d.success;
  } catch (e) {
    return false; // Cloudflare injoignable : on refuse plutôt que de laisser passer.
  }
}

// Limite par IP en mémoire : simple et sans table dédiée. Chaque instance
// serverless garde son propre compteur (remis à zéro au recyclage de
// l'instance) — suffisant pour casser les rafales, Turnstile fait le reste.
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || 'inconnue';
}

const ipHits = new Map();
function overIpLimit(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (hits.length >= LIMIT_PER_HOUR) return true;
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear(); // borne mémoire, au pire on relâche la limite
  return false;
}

async function handler(req, res) {
  // Toute exception imprévue doit ressortir en JSON propre (jamais la page
  // d'erreur brute de Vercel, illisible côté formulaire).
  try {
    return await handleCandidature(req, res);
  } catch (e) {
    console.error('Erreur inattendue :', e);
    return res.status(500).json({ error: 'Erreur interne inattendue. Réessayez plus tard.' });
  }
}

async function handleCandidature(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }
  // trim : un espace ou un retour à la ligne collé avec la valeur dans Vercel
  // ferait planter createClient (« Invalid URL »).
  let supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (supabaseUrl && !/^https?:\/\//i.test(supabaseUrl)) supabaseUrl = `https://${supabaseUrl}`;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Service momentanément indisponible.' });
  }

  let form;
  try {
    form = await parseForm(req);
  } catch (e) {
    return res.status(400).json({ error: 'Requête invalide.' });
  }
  const { fields, file, truncated } = form;

  // 1. Honeypot : réponse succès factice, rien n'est stocké.
  if (fields.site_web) {
    return res.status(200).json({ ok: true });
  }

  const fieldError = validateFields(fields);
  if (fieldError) return res.status(400).json({ error: fieldError });

  const ip = clientIp(req);

  // 2. Turnstile.
  if (!(await verifyTurnstile(fields.turnstile_token, ip))) {
    return res.status(403).json({ error: 'Vérification anti-robots échouée. Rechargez la page et réessayez.' });
  }

  // 3. Limite par IP.
  if (overIpLimit(ip)) {
    return res.status(429).json({ error: 'Trop de dépôts récents. Réessayez dans une heure.' });
  }

  // 4. Fichier.
  if (!file || !file.buf.length) return res.status(400).json({ error: 'CV manquant.' });
  if (truncated || file.buf.length > MAX_FILE) {
    return res.status(400).json({ error: 'Fichier trop lourd : 4 Mo maximum.' });
  }
  const extMatch = file.name.match(/\.(pdf|jpe?g|png)$/i);
  let ext = extMatch && extMatch[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!ext || !CONTENT_TYPES[ext] || !goodMagic(file.buf, ext)) {
    return res.status(400).json({ error: 'Format non accepté : PDF, JPG ou PNG uniquement.' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // 5. Disjoncteur global, compté dans la base elle-même (Resume source=SITE
  // des dernières 24 h) : fiable même avec plusieurs instances serverless.
  const overCap = await overDailyCap(supabase);
  if (overCap === null) {
    return res.status(500).json({ error: 'Erreur interne, réessayez plus tard.' });
  }
  if (overCap) {
    return res.status(429).json({
      error: 'Beaucoup de candidatures aujourd\u2019hui ! Réessayez demain, ou envoyez votre CV à contact@swipelink.fr.',
    });
  }

  try {
    await transmitToPipeline(supabase, file.buf, ext);
  } catch (e) {
    // Le détail (message Supabase) reste dans les logs Vercel, jamais à l'écran.
    console.error('Dépôt de CV échoué :', e && e.message);
    return res.status(500).json({ error: "Impossible d'enregistrer le CV, réessayez plus tard." });
  }

  return res.status(200).json({ ok: true });
}

// true = plafond atteint, false = ok, null = compte impossible (base en erreur).
async function overDailyCap(supabase) {
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await supabase
    .from('Resume')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'SITE')
    .gte('created_at', oneDayAgo);
  if (error) return null; // fail closed : sans compte fiable, on refuse le dépôt
  return (count || 0) >= DAILY_CAP;
}

// Un CV déposé sur le site suit le MÊME cheminement que l'upload « volume »
// du produit (admin/upload-resumes) :
//   1. fichier dans le bucket "resumes", à la racine, nom `uuid.ext`
//      (uploadOneResume : upsert + cacheControl 3600) ;
//   2. ligne Resume minimale { bucket_path, upload_mode: VOLUME,
//      target_offer_id: null, source: SITE } (insertManyResumesAction) — les
//      défauts de la base posent ocr_state/llm_state = 'waiting' et
//      parsing_pipeline = 'main'.
// Le trigger SQL notify_ocr (INSERT sur Resume) appelle l'event-manager
// lui-même : aucun appel réseau à faire ici. Le pipeline OCR → LLM extrait
// ensuite l'identité du CV et crée le Candidat ; l'identité saisie dans le
// formulaire n'est volontairement PAS écrite sur le Resume, comme en volume.
// Rollback : si l'insert échoue, le fichier déposé est retiré.
async function transmitToPipeline(supabase, buf, ext) {
  const bucketPath = `${crypto.randomUUID()}.${ext}`;
  {
    const { error } = await supabase.storage.from('resumes').upload(bucketPath, buf, {
      upsert: true,
      contentType: CONTENT_TYPES[ext],
      cacheControl: '3600',
    });
    if (error) throw new Error(`Upload du CV : ${error.message}`);
  }

  const { error } = await supabase.from('Resume').insert({
    bucket_path: bucketPath,
    upload_mode: 'VOLUME',
    target_offer_id: null,
    source: 'SITE',
  });
  if (error) {
    await supabase.storage.from('resumes').remove([bucketPath]);
    throw new Error(`Resume : ${error.message}`);
  }
}

module.exports = handler;
module.exports.parseForm = parseForm;
module.exports.validateFields = validateFields;
module.exports.goodMagic = goodMagic;
module.exports.transmitToPipeline = transmitToPipeline;
module.exports.overDailyCap = overDailyCap;
module.exports.clientIp = clientIp;
