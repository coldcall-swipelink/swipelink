// api/candidature.js — réception des candidatures (espace candidat).
//
// Un dépôt sur le site est traité exactement comme un CV uploadé dans le CSM
// (cf. transmitMetaLead côté CSM) : fichier dans le bucket "resumes", ligne
// Resume (identité + bucket_path + source SITE), Candidat réutilisé au même
// téléphone ou créé, lien Candidate_to_resume + main_resume_id. Aucune table
// dédiée au site : tout part dans les tables métier existantes, le candidat
// apparaît directement dans le backoffice.
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    return res.status(500).json({ error: "Impossible d'enregistrer le CV, réessayez plus tard." });
  }

  return res.status(200).json({ ok: true });
}

// Variantes de téléphone qui valent la peine d'être rapprochées d'un Candidat
// existant (0X… ↔ +33X…) — même logique que le CSM.
function phoneVariants(phone) {
  const raw = phone.trim();
  const digits = raw.replace(/[^\d+]/g, '');
  const out = new Set([raw, digits]);
  if (digits.startsWith('+33')) out.add(`0${digits.slice(3)}`);
  else if (digits.startsWith('33') && digits.length === 11) out.add(`0${digits.slice(2)}`);
  else if (digits.startsWith('0') && digits.length === 10) out.add(`+33${digits.slice(1)}`);
  return [...out].filter((v) => v.length >= 6);
}

// Un CV déposé sur le site crée les lignes métier, la même forme que le CSM
// produit pour un CV déposé sur un lead Meta (source SITE au lieu de META) :
//   1. dépôt du fichier dans le bucket "resumes" ;
//   2. création du Resume (identité + bucket_path + source SITE) ;
//   3. réutilisation du Candidat au même téléphone, sinon création ;
//   4. lien Candidate_to_resume (+ main_resume_id quand le candidat n'en a pas).
// Pas de Candidate_to_offer : un dépôt spontané ne vise aucune offre — le
// candidat rejoint la CVthèque, pas la file « Validation candidat ».
// Rollback best effort en sens inverse en cas d'échec.
async function transmitToPipeline(supabase, candidat, buf, ext) {
  // 1 — le fichier CV. Chemin unique par dépôt, dans un espace de noms dédié.
  const bucketPath = `site/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  {
    const { error } = await supabase.storage.from('resumes').upload(bucketPath, buf, {
      upsert: true,
      contentType: CONTENT_TYPES[ext],
      cacheControl: 'no-store, max-age=0, must-revalidate',
    });
    if (error) throw new Error(`Upload du CV : ${error.message}`);
  }

  let resumeId = null;
  let createdCandidateId = null;
  let candidateId = null;
  let linkId = null;
  let setMainResume = false;

  try {
    // 2 — la ligne Resume (identité + chemin du CV + provenance). Les noms et
    // emails du backoffice sont lus depuis le Resume, il doit donc les porter ;
    // source = SITE marque d'où vient le CV. Si la base refuse cette valeur
    // (enum sans SITE), on réessaie sans elle plutôt que de perdre le dépôt —
    // même repli que le CSM pour source = META.
    const resumeRow = {
      first_name: candidat.prenom,
      last_name: candidat.nom,
      email: candidat.email,
      phone_number: candidat.telephone,
      bucket_path: bucketPath,
    };
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

    // 3 — le Candidat : réutiliser un existant au même téléphone, sinon créer.
    const { data: existing } = await supabase
      .from('Candidate')
      .select('id, main_resume_id')
      .in('phone_number', phoneVariants(candidat.telephone))
      .limit(1);
    if (existing && existing.length > 0) {
      candidateId = String(existing[0].id);
      setMainResume = !existing[0].main_resume_id;
    }
    if (!candidateId) {
      const candIns = await supabase
        .from('Candidate')
        .insert({ phone_number: candidat.telephone })
        .select('id')
        .single();
      if (candIns.error) throw new Error(`Candidat : ${candIns.error.message}`);
      candidateId = createdCandidateId = String(candIns.data.id);
      setMainResume = true;
    }

    // 4 — le lien CV ↔ candidat. Convention amont : Candidate.main_resume_id
    // pointe vers le LIEN Candidate_to_resume, pas vers le Resume lui-même.
    const linkIns = await supabase
      .from('Candidate_to_resume')
      .insert({ candidate_id: candidateId, resume_id: resumeId })
      .select('id')
      .single();
    if (linkIns.error) throw new Error(`Lien CV : ${linkIns.error.message}`);
    linkId = String(linkIns.data.id);
    if (setMainResume) {
      await supabase.from('Candidate').update({ main_resume_id: linkId }).eq('id', candidateId);
    }
  } catch (e) {
    // Rollback best effort, enfants d'abord (même ordre que le CSM). Le chemin
    // du fichier est unique par tentative : on le supprime aussi.
    if (linkId) await supabase.from('Candidate_to_resume').delete().eq('id', linkId);
    if (setMainResume && candidateId && !createdCandidateId) {
      await supabase.from('Candidate').update({ main_resume_id: null }).eq('id', candidateId);
    }
    if (createdCandidateId) await supabase.from('Candidate').delete().eq('id', createdCandidateId);
    if (resumeId) await supabase.from('Resume').delete().eq('id', resumeId);
    await supabase.storage.from('resumes').remove([bucketPath]);
    throw e;
  }
}

module.exports = handler;
module.exports.parseForm = parseForm;
module.exports.validateFields = validateFields;
module.exports.goodMagic = goodMagic;
module.exports.phoneVariants = phoneVariants;
module.exports.transmitToPipeline = transmitToPipeline;
