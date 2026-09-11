# Espace candidat — mise en service du dépôt de CV

Le formulaire `/candidats` envoie les candidatures à la fonction `api/candidature.js`,
qui suit **exactement le cheminement de l'upload « volume » du produit Swipelink**
(`admin/upload-resumes`) :

1. le fichier part dans le bucket `resumes` du projet Supabase de production,
   à la racine, nom aléatoire `<uuid>.<ext>` (upsert, cacheControl 3600) ;
2. une ligne `Resume` **minimale** est créée, identique à `insertManyResumesAction` :
   `{ bucket_path, upload_mode: 'VOLUME', target_offer_id: null, source: 'SITE' }`.
   Les défauts de la base posent `ocr_state`/`llm_state = 'waiting'` et
   `parsing_pipeline = 'main'`.
3. **Rien d'autre à faire** : le trigger SQL `notify_ocr` (INSERT sur `Resume`)
   appelle lui-même l'event-manager, qui lance l'OCR puis le parsing LLM
   (`notify_llm` quand `raw_text` est écrit). Le pipeline extrait l'identité du
   CV et crée le Candidat.

Points de comportement hérités du mode volume :

- **Doublons** : un CV dont le téléphone correspond à un Candidat existant est
  **ignoré** par le pipeline (`manageDuplicates` : en VOLUME on ne traite pas le
  doublon ; seul le mode PRECISION met à jour le candidat existant).
- **Identité du formulaire** : volontairement non écrite sur le `Resume` — comme
  en volume, c'est le parsing qui l'extrait du CV (le téléphone y est requis).
- **Formats** : PDF, JPG, PNG (les formats du produit), 4 Mo max, type réel
  vérifié par les premiers octets.
- Un CV dont le parsing échoue remonte dans « CV en échec » du CSM.
- Provenance visible : `Resume.source = 'SITE'` (valeur de l'enum `Resume_source`).

## 1. Configurer Vercel

Projet Vercel → Settings → Environment Variables, cochées **Production ET Preview** :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | `https://qxjpkjetclwxxpqkbibv.supabase.co` (le projet de production) |
| `SUPABASE_SERVICE_ROLE_KEY` | la clé service_role **de ce même projet** (⚠️ secrète, jamais côté client) |
| `TURNSTILE_SECRET_KEY` | la secret key du widget Cloudflare Turnstile (voir étape 2) |

(`EVENT_MANAGER_URL` / `EVENT_MANAGER_API_KEY` ne servent plus : le trigger en
base notifie l'event-manager tout seul. Elles peuvent être retirées.)

Un build ne prend en compte que les variables présentes à son lancement : après un
changement, redéployer (Deployments → Redeploy, ou un nouveau push).

## 2. Cloudflare Turnstile (anti-robots)

Widget créé sur dash.cloudflare.com → Turnstile (hostnames : `swipelink.fr` +
`vercel.app` pour les previews). La **site key** est dans `candidats.html`
(constante `TURNSTILE_SITE_KEY`), la **secret key** dans `TURNSTILE_SECRET_KEY`
sur Vercel — les deux vont par paire.

## Sécurité en place (résumé)

- Honeypot (champ caché) : les robots reçoivent un faux succès, rien n'est stocké.
- Turnstile vérifié côté serveur (échec ou Cloudflare injoignable ⇒ refus).
- Limite par IP : 5 dépôts/heure, comptés en mémoire par instance serverless.
- Fichier : PDF/JPG/PNG uniquement, 4 Mo max, octets magiques vérifiés.
- Champs bornés et validés côté serveur (le client ne fait foi de rien).
- Rollback : si la création du Resume échoue, le fichier déposé est retiré.
