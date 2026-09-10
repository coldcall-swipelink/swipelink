# Espace candidat — mise en service du dépôt de CV

Le formulaire `/candidats` envoie les candidatures à la fonction `api/candidature.js`,
qui suit **exactement le cheminement de l'upload « volume » du produit Smartlink** :

1. le fichier part dans le bucket `resumes` du projet Supabase de production,
   à la racine (nom aléatoire `<uuid>.<ext>`) ;
2. une ligne `Resume` est créée en mode volume : `upload_mode = 'volume'`,
   `parsing_pipeline = 'main'`, `llm_state = 'waiting'` (l'état que `claim_llm`
   réclame), **pas de `target_offer_id`** (dépôt spontané, aucune offre visée),
   `source = 'SITE'` pour la provenance (repli sans `source` si l'enum la refuse) ;
3. la tâche LLM est mise en file auprès de l'event-manager
   (`POST /llm/llm-task` avec `{ resumeId, delaySeconds: 5, pipeline: 'main' }`,
   même appel que le CSM).

C'est ensuite le pipeline LLM qui parse le CV et crée le Candidat et les liens —
rien n'est créé à la main, et aucune table dédiée au site. Si l'event-manager est
indisponible, la ligne reste en `waiting` et `resume_reconcile` la reprend.

## 1. Configurer Vercel

Projet Vercel → Settings → Environment Variables, cochées **Production ET Preview** :

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | `https://qxjpkjetclwxxpqkbibv.supabase.co` (le projet de production, celui du CSM) |
| `SUPABASE_SERVICE_ROLE_KEY` | la clé service_role **de ce même projet** (⚠️ secrète, jamais côté client) |
| `EVENT_MANAGER_URL` | même valeur que dans le projet Vercel du CSM |
| `EVENT_MANAGER_API_KEY` | même valeur que dans le projet Vercel du CSM |
| `TURNSTILE_SECRET_KEY` | la secret key du widget Cloudflare Turnstile (voir étape 2) |

Un build ne prend en compte que les variables présentes à son lancement : après un
changement, redéployer (Deployments → Redeploy, ou un nouveau push).

## 2. Cloudflare Turnstile (anti-robots)

Widget créé sur dash.cloudflare.com → Turnstile (hostnames : `swipelink.fr` +
`vercel.app` pour les previews). La **site key** est dans `candidats.html`
(constante `TURNSTILE_SITE_KEY`), la **secret key** dans `TURNSTILE_SECRET_KEY`
sur Vercel — les deux vont par paire.

## 3. Consulter les candidatures

Les candidats déposés depuis le site suivent le pipeline normal : une fois parsés
par le LLM, ils apparaissent dans le backoffice comme n'importe quel CV uploadé en
mode volume (provenance `Resume.source = 'SITE'`). Un CV dont le parsing échoue
remonte dans « CV en échec » du CSM, comme les autres.

## Sécurité en place (résumé)

- Honeypot (champ caché) : les robots reçoivent un faux succès, rien n'est stocké.
- Turnstile vérifié côté serveur (échec ou Cloudflare injoignable ⇒ refus).
- Limite par IP : 5 dépôts/heure, comptés en mémoire par instance serverless.
- Fichier : PDF/Word uniquement, 4 Mo max, type réel vérifié par les premiers octets.
- Champs bornés et validés côté serveur (le client ne fait foi de rien).
- Rollback : si la création du Resume échoue, le fichier déposé est retiré et le
  candidat reçoit une erreur nommant l'étape en cause.
