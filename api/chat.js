// api/chat.js — messages du chat « Hugo est en ligne » (bulle en bas à droite).
//
// Le widget (assets/script.js, section « chat ») n'autorise l'envoi qu'une
// fois prénom, nom et e-mail renseignés ; ce point d'entrée le revérifie,
// car seul le serveur fait foi. Chaque message part par e-mail (Resend) à
// CHAT_TO et est archivé dans Supabase (table site_chat_messages) quand la
// base est configurée : si l'e-mail échoue mais que l'archivage passe, la
// conversation n'est pas perdue.
//
// Sécurité, même grille que api/candidature.js :
//   1. Honeypot : champ caché "site_web" rempli => succès factice, rien n'est stocké.
//   2. Limite par IP : 12 messages / 10 min, en mémoire.
//   3. Validation stricte : champs bornés, e-mail vérifié, message 2 à 2000 caractères.
//
// Configuration : voir docs/SETUP-CHAT.md.

const { createClient } = require('@supabase/supabase-js');
const { clientIp } = require('./candidature');

const LIMIT = 12;
const WINDOW_MS = 10 * 60 * 1000;
const ipHits = new Map();

function overIpLimit(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();
  return hits.length > LIMIT;
}

function validate(b) {
  const prenom = String(b.prenom || '').trim();
  const nom = String(b.nom || '').trim();
  const email = String(b.email || '').trim();
  const message = String(b.message || '').trim();
  const page = String(b.page || '').trim().slice(0, 200);
  if (prenom.length < 2 || prenom.length > 60) return { error: 'Prénom invalide.' };
  if (nom.length < 2 || nom.length > 60) return { error: 'Nom invalide.' };
  if (email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'Email invalide.' };
  if (message.length < 2) return { error: 'Message vide.' };
  if (message.length > 2000) return { error: 'Message trop long : 2000 caractères maximum.' };
  return { value: { prenom, nom, email, message, page } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendEmail(m, ip) {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) return { sent: false, reason: 'RESEND_API_KEY absente' };
  const to = String(process.env.CHAT_TO || 'contact@swipelink.fr').trim();
  const from = String(process.env.CHAT_FROM || 'Chat Swipelink <chat@swipelink.fr>').trim();
  const subject = `[Chat] ${m.prenom} ${m.nom} — ${m.message.slice(0, 60)}${m.message.length > 60 ? '…' : ''}`;
  const html = `<p><strong>${escapeHtml(m.prenom)} ${escapeHtml(m.nom)}</strong> &lt;${escapeHtml(m.email)}&gt;</p>
<p style="white-space:pre-wrap">${escapeHtml(m.message)}</p>
<hr><p style="color:#64748b;font-size:12px">Page : ${escapeHtml(m.page || '—')} · IP : ${escapeHtml(ip)}</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: m.email, subject, html }),
  });
  if (!r.ok) return { sent: false, reason: `Resend ${r.status}` };
  return { sent: true };
}

async function archive(m, ip) {
  let url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url || !key) return { stored: false, reason: 'Supabase non configuré' };
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await supabase.from('site_chat_messages').insert({
    prenom: m.prenom, nom: m.nom, email: m.email, message: m.message, page: m.page || null, ip,
  });
  return error ? { stored: false, reason: error.message } : { stored: true };
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 16 * 1024) throw new Error('too big'); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Requête invalide.' }); }

  if (body.site_web) return res.status(200).json({ ok: true }); // honeypot

  const v = validate(body);
  if (v.error) return res.status(400).json({ error: v.error });

  const ip = clientIp(req);
  if (overIpLimit(ip)) return res.status(429).json({ error: 'Trop de messages, réessayez dans quelques minutes.' });

  const [mail, store] = await Promise.all([
    sendEmail(v.value, ip).catch((e) => ({ sent: false, reason: e.message })),
    archive(v.value, ip).catch((e) => ({ stored: false, reason: e.message })),
  ]);
  if (!mail.sent && !store.stored) {
    console.error('chat: ni e-mail ni archivage', mail.reason, store.reason);
    return res.status(503).json({ error: 'Le chat est momentanément indisponible. Écrivez-nous à contact@swipelink.fr.' });
  }
  if (!mail.sent) console.warn('chat: e-mail non envoyé (', mail.reason, '), message archivé');
  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.validate = validate;
module.exports.overIpLimit = overIpLimit;
