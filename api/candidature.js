// api/candidature.js — réception des candidatures (espace candidat).
//
// Un dépôt sur le site suit exactement le cheminement de l'upload « volume »
// du produit Smartlink : fichier dans le bucket "resumes", ligne Resume en
// mode volume (upload_mode = 'volume', parsing_pipeline = 'main',
// llm_state = 'waiting', pas de target_offer_id), puis mise en file de la
// tâche LLM auprès de l'event-manager. Le pipeline LLM parse le CV et crée
// le Candidat — rien n'est créé à la main ici, et aucune table dédiée au site.
//
// Sécurité appliquée côté serveur (la seule qui fait foi) :
//   1. Honeypot : le champ caché "site_web" rempli => réponse succès factice, rien n'est stocké.
//   2. Cloudflare Turnstile : le jeton est vérifié avec la clé secrète (TURNSTILE_SECRET_KEY).
//   3. Limite par IP : 5 dépôts max par heure (en mémoire, par instance serverless).
//   4. Validation stricte : champs bornés, fichier PDF/Word uniquement, 4 Mo max,
//      type réel vérifié par les premiers octets (pas seulement l'extension).
//
// Configuration : voir docs/SETUP-CANDIDATURES.md.

const crypto = require('crypto');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const MAX_FILE = 4 * 1024 * 1024; // 4 Mo (le corps de requête Vercel est plafonné à 4,5 Mo)
const LIMIT_PER_HOUR = 5;
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
// Clé secrète de TEST Cloudflare (accepte tout) tant que TURNSTILE_SECRET_KEY n'est pas configurée.
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

function goodMagic(buf, ext) {
  if (buf.length < 8) return false;
  if (ext === 'pdf') return buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (ext === 'doc') return buf.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (ext === 'docx') return buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
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
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY || TURNSTILE_TEST_SECRET,
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

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'inconnue';

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
  const extMatch = file.name.match(/\.(pdf|docx?)$/i);
  const ext = extMatch && extMatch[1].toLowerCase();
  if (!ext || !CONTENT_TYPES[ext] || !goodMagic(file.buf, ext)) {
    return res.status(400).json({ error: 'Format non accepté : PDF ou Word uniquement.' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const candidat = {
    prenom: fields.prenom.trim(),
    nom: fields.nom.trim(),
    telephone: fields.telephone.trim(),
    email: fields.email.trim().toLowerCase(),
  };

  try {
    await transmitToPipeline(supabase, candidat, file.buf, ext);
  } catch (e) {
    console.error('Dépôt de CV échoué :', e && e.message);
    // L'étape en tête du message ("Upload du CV", "Resume", "Candidat",
    // "Lien CV") est affichée au candidat : sans détail interne, mais assez
    // pour diagnostiquer depuis l'écran.
    const stage = String((e && e.message) || '').split(':')[0].trim();
    return res.status(500).json({
      error: `Impossible d'enregistrer le CV${stage ? ` (étape : ${stage})` : ''}. Réessayez plus tard.`,
    });
  }

  return res.status(200).json({ ok: true });
}

// Un CV déposé sur le site suit le MÊME cheminement que l'upload « volume »
// du produit Smartlink (multi-diffusion) :
//   1. dépôt du fichier dans le bucket "resumes" ;
//   2. création du Resume en mode volume : upload_mode = 'volume',
//      parsing_pipeline = 'main', llm_state = 'waiting' (l'état réclamable par
//      claim_llm), pas de target_offer_id (dépôt spontané, aucune offre visée) ;
//   3. mise en file de la tâche LLM auprès de l'event-manager
//      (POST /llm/llm-task, même appel que le CSM dans failed-cv.ts).
// C'est ensuite le pipeline LLM qui parse le CV et crée le Candidat et les
// liens — on ne crée RIEN à la main ici, exactement comme le flux volume.
// Rollback : si l'insertion du Resume échoue, le fichier déposé est retiré.
async function transmitToPipeline(supabase, candidat, buf, ext) {
  // 1 — le fichier CV, à la racine du bucket, nom aléatoire.
  const bucketPath = `${crypto.randomUUID()}.${ext}`;
  {
    const { error } = await supabase.storage.from('resumes').upload(bucketPath, buf, {
      upsert: true,
      contentType: CONTENT_TYPES[ext],
      cacheControl: 'no-store, max-age=0, must-revalidate',
    });
    if (error) throw new Error(`Upload du CV : ${error.message}`);
  }

  // 2 — le Resume en mode volume. On renseigne quand même l'identité saisie
  // dans le formulaire (le parsing LLM complètera/confirmera depuis le CV) ;
  // source = SITE marque la provenance, avec repli sans source si l'enum de
  // la base la refuse (même repli que le CSM pour source = META).
  const resumeRow = {
    first_name: candidat.prenom,
    last_name: candidat.nom,
    email: candidat.email,
    phone_number: candidat.telephone,
    bucket_path: bucketPath,
    upload_mode: 'volume',
    parsing_pipeline: 'main',
    llm_state: 'waiting',
  };
  let resumeId = null;
  try {
    const resIns = await supabase
      .from('Resume')
      .insert({ ...resumeRow, source: 'SITE' })
      .select('id')
      .single();
    if (!resIns.error) {
      resumeId = String(resIns.data.id);
    } else if (/source|enum|invalid input value/i.test(resIns.error.message)) {
      const retry = await supabase.from('Resume').insert(resumeRow).select('id').single();
      if (retry.error) throw new Error(`Resume : ${retry.error.message}`);
      resumeId = String(retry.data.id);
    } else {
      throw new Error(`Resume : ${resIns.error.message}`);
    }
  } catch (e) {
    await supabase.storage.from('resumes').remove([bucketPath]);
    throw e;
  }

  // 3 — la tâche LLM (event-manager), avec un petit délai pour que la ligne
  // 'waiting' soit déjà visible de claim_llm — mêmes paramètres que le CSM.
  // Best effort : si l'event-manager est indisponible ou non configuré, la
  // ligne reste en 'waiting' et resume_reconcile la reprendra au prochain
  // passage — le dépôt du candidat n'échoue pas pour autant.
  const emBase = String(process.env.EVENT_MANAGER_URL || '').trim().replace(/\/+$/, '');
  if (!emBase) {
    console.warn('EVENT_MANAGER_URL absente : Resume', resumeId, "en 'waiting', reprise par le cron.");
    return;
  }
  try {
    const headers = { 'content-type': 'application/json' };
    const emKey = String(process.env.EVENT_MANAGER_API_KEY || '').trim();
    if (emKey) headers['x-api-key'] = emKey;
    const r = await fetch(`${emBase}/llm/llm-task`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resumeId, delaySeconds: 5, pipeline: 'main' }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) throw new Error(`(${r.status}) ${text.slice(0, 200)}`);
    console.info(`Dépôt site : Resume ${resumeId} en file → ${text.slice(0, 200)}`);
  } catch (e) {
    console.warn('Event-manager injoignable (Resume', resumeId, "reste en 'waiting') :", e && e.message);
  }
}

module.exports = handler;
module.exports.parseForm = parseForm;
module.exports.validateFields = validateFields;
module.exports.goodMagic = goodMagic;
module.exports.transmitToPipeline = transmitToPipeline;
