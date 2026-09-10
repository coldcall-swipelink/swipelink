# Espace candidat — mise en service du stockage des CV

Le formulaire `/candidats` envoie les candidatures à la fonction `api/candidature.js`,
qui stocke le CV dans Supabase. Tant que les variables d'environnement ci-dessous ne sont
pas configurées dans Vercel, l'API répond « Service momentanément indisponible » et la page
invite le candidat à écrire à contact@swipelink.fr.

## 1. Créer le projet Supabase

Sur https://supabase.com (gratuit pour commencer) : créer un projet, puis :

### a. La table `candidatures` — SQL Editor, exécuter :

```sql
create table public.candidatures (
  id uuid primary key default gen_random_uuid(),
  prenom text not null,
  nom text not null,
  telephone text not null,
  email text not null,
  cv_path text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);

-- Sécurité : RLS activé sans aucune policy publique.
-- Seule la clé service role (utilisée par l'API, côté serveur) peut lire/écrire.
alter table public.candidatures enable row level security;

create index candidatures_ip_hash_created_at on public.candidatures (ip_hash, created_at);
create index candidatures_email_created_at on public.candidatures (email, created_at);

-- Verrou « une alerte volume par jour » (utilisée par l'API pour ne pas spammer d'emails)
create table public.alertes (
  jour date primary key,
  type text not null,
  created_at timestamptz not null default now()
);
alter table public.alertes enable row level security;
```

### b. Le bucket de stockage

Storage → New bucket → nom : `cvs` — **laisser le bucket privé** (Public bucket décoché).
Aucune policy à ajouter : seule la clé service role y accède.

## 2. Configurer Vercel

Projet Vercel → Settings → Environment Variables (environnement Production) :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role (⚠️ secrète, jamais côté client) |
| `TURNSTILE_SECRET_KEY` | voir étape 3 |
| `IP_HASH_SALT` | une chaîne aléatoire quelconque (ex. générée sur place), pour pseudonymiser les IP |
| `RESEND_API_KEY` | *(optionnel)* clé API https://resend.com (gratuit) pour recevoir l'alerte volume par email |
| `ALERT_EMAIL` | *(optionnel)* l'adresse qui reçoit l'alerte volume |
| `DAILY_CAP` | *(optionnel, défaut 200)* disjoncteur : dépôts max sur 24 h, tout confondu |
| `ALERT_THRESHOLD` | *(optionnel, défaut 50)* seuil d'alerte volume sur 24 h |

Puis redéployer (Deployments → Redeploy) pour que les variables soient prises en compte.

## 3. Activer Cloudflare Turnstile (anti-robots)

1. https://dash.cloudflare.com → Turnstile → Add site (gratuit), domaine `swipelink.fr`.
2. Récupérer la **site key** (publique) et la **secret key**.
3. Dans `candidats.html`, remplacer la valeur de `TURNSTILE_SITE_KEY` (clé de test
   `1x00000000000000000000AA`) par la site key.
4. Mettre la secret key dans la variable `TURNSTILE_SECRET_KEY` sur Vercel.

Tant que les clés de test sont en place, le widget s'affiche et le flux fonctionne,
mais il laisse tout passer : à remplacer avant d'annoncer publiquement la page.

## 4. Consulter les candidatures

- La liste : Supabase → Table Editor → `candidatures`.
- Les CV : Supabase → Storage → `cvs` (chemin dans la colonne `cv_path`).

## 5. Transmission au pipeline métier (CSM)

Après chaque dépôt réussi, l'API crée en plus les lignes métier — la même
forme que le CSM produit quand un CV est déposé sur un lead Meta :

1. le fichier est copié dans le bucket `resumes` (chemin `site/AAAA-MM-JJ/<uuid>.<ext>`) ;
2. une ligne `Resume` est créée (identité + `bucket_path` + `source = SITE` ;
   si l'enum de la base refuse `SITE`, l'insertion est refaite sans `source`) ;
3. le `Candidate` existant au même téléphone (variantes `0X…` ↔ `+33X…`) est
   réutilisé, sinon créé ;
4. le lien `Candidate_to_resume` est créé, et `Candidate.main_resume_id`
   pointe vers ce lien quand le candidat n'en avait pas (convention amont).

Pas de `Candidate_to_offer` : un dépôt spontané ne vise aucune offre — le
candidat rejoint la CVthèque du backoffice, pas la file « Validation candidat ».

Pour que cette transmission fonctionne, `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY` doivent pointer vers le **projet Supabase de
production** (celui que lit le CSM), qui porte les tables `Resume`,
`Candidate`, `Candidate_to_resume` et le bucket `resumes`. Les tables
`candidatures` et `alertes` de l'étape 1 sont alors à créer dans ce même
projet. Cette étape est **best effort** : si les tables ou le bucket
n'existent pas (projet Supabase dédié au site), la transmission échoue
silencieusement (visible dans les logs Vercel), le dépôt reste enregistré
dans `candidatures` et le candidat reçoit toujours une réponse de succès.
En cas d'échec en cours de route, les lignes déjà créées sont annulées en
sens inverse (rollback best effort), fichier compris.

## Sécurité en place (résumé)

- Honeypot (champ caché) : les robots reçoivent un faux succès, rien n'est stocké.
- Turnstile vérifié côté serveur (échec ou Cloudflare injoignable ⇒ refus).
- Limite par IP : 5 dépôts/heure (IP pseudonymisée par hachage salé, RGPD).
- Fichier : PDF/Word uniquement, 4 Mo max, type réel vérifié par les premiers octets.
- Champs bornés et validés côté serveur (le client ne fait foi de rien).
- Bucket privé + RLS sans policy : aucune lecture publique possible.
- Disjoncteur global : 200 dépôts max/24 h (attaque distribuée ⇒ coût borné),
  avec alerte email à 50 (une seule par jour) si Resend est configuré.
- Déduplication : un même email sous 7 jours met à jour la candidature
  existante (nouveau CV remplace l'ancien) au lieu de créer un doublon.
- Rétention RGPD : purge automatique des candidatures (et CV) de plus de
  2 ans, par petits lots à chaque nouveau dépôt.
