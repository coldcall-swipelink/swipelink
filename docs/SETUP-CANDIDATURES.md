# Espace candidat — mise en service du dépôt de CV

Le formulaire `/candidats` envoie les candidatures à la fonction `api/candidature.js`,
qui traite chaque dépôt **exactement comme le CSM traite un CV uploadé** : le fichier
part dans le bucket `resumes` du projet Supabase de production, et les lignes métier
sont créées (`Resume` avec `source = SITE`, `Candidate` réutilisé au même téléphone ou
créé, lien `Candidate_to_resume` + `main_resume_id`). Le candidat apparaît donc
directement dans le backoffice, dans la CVthèque — rien à créer côté base : aucune
table ni bucket dédié au site.

Tant que les variables d'environnement ci-dessous ne sont pas configurées dans Vercel,
l'API répond « Service momentanément indisponible » et la page invite le candidat à
écrire à contact@swipelink.fr.

## 1. Configurer Vercel

Projet Vercel → Settings → Environment Variables (environnement Production) —
les valeurs viennent du **projet Supabase de production** (celui que lit le CSM) :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | Supabase (projet de production) → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role (⚠️ secrète, jamais côté client) |
| `TURNSTILE_SECRET_KEY` | voir étape 2 |

Puis redéployer (Deployments → Redeploy) pour que les variables soient prises en compte.

## 2. Activer Cloudflare Turnstile (anti-robots)

1. https://dash.cloudflare.com → Turnstile → Add site (gratuit), domaine `swipelink.fr`.
2. Récupérer la **site key** (publique) et la **secret key**.
3. Dans `candidats.html`, remplacer la valeur de `TURNSTILE_SITE_KEY` (clé de test
   `1x00000000000000000000AA`) par la site key.
4. Mettre la secret key dans la variable `TURNSTILE_SECRET_KEY` sur Vercel.

Tant que les clés de test sont en place, le widget s'affiche et le flux fonctionne,
mais il laisse tout passer : à remplacer avant d'annoncer publiquement la page.

## 3. Consulter les candidatures

Les candidats déposés depuis le site sont dans le backoffice (CSM), comme n'importe
quel candidat : tables `Resume` / `Candidate`, CV dans le bucket `resumes` (chemins
`site/AAAA-MM-JJ/…`). La provenance est marquée par `Resume.source = SITE`.

Pas de `Candidate_to_offer` : un dépôt spontané ne vise aucune offre — le candidat
rejoint la CVthèque, pas la file « Validation candidat ».

## Sécurité en place (résumé)

- Honeypot (champ caché) : les robots reçoivent un faux succès, rien n'est stocké.
- Turnstile vérifié côté serveur (échec ou Cloudflare injoignable ⇒ refus).
- Limite par IP : 5 dépôts/heure, comptés en mémoire par instance serverless
  (aucune table nécessaire ; Turnstile reste la vraie barrière anti-robots).
- Fichier : PDF/Word uniquement, 4 Mo max, type réel vérifié par les premiers octets.
- Champs bornés et validés côté serveur (le client ne fait foi de rien).
- Rollback : si une étape échoue en cours de route, les lignes déjà créées et le
  fichier déposé sont annulés en sens inverse (best effort), et le candidat reçoit
  une erreur claire.
