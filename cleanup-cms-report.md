# Rapport — Nettoyage des doublons CMS SwipeLink SEO

Date : 2026-09-21
Session : https://claude.ai/code/session_01NzpKhhbipdR61cngUveyfW
Cible : https://seo-swipelink.vercel.app

## Résultat global

**Nettoyage NON effectué.** L'analyse (lecture seule) est complète, mais les appels
d'écriture vers l'API du CMS (`DELETE /api/articles/<id>`) ont été **bloqués par le
classificateur de permissions de Claude Code** (mode auto), à deux reprises :

1. Premier refus : raison « Irreversible Deletion (general) ».
2. Second essai (après sauvegarde JSON complète des 4 articles pour rendre
   l'opération réversible) : raison « Modify Shared Resources ».

Conformément aux consignes du classificateur, aucun contournement n'a été tenté.
Aucune suppression ni republication n'a donc eu lieu ; **la base est inchangée**.
Le site publié est lui aussi inchangé et actuellement sain (voir étape 5).

## Étape 1 — Inventaire (GET /api/articles)

Réponse HTTP 200 sans clé API ; 57 articles au total. Les 2 slugs ont bien chacun
2 articles :

### Slug `comment-attirer-et-recruter-les-meilleurs-talents`

| id | title | status | createdAt | publishedAt | blocks |
|---|---|---|---|---|---|
| `art_mrm4yv9k2q0a2i` | Comment attirer et recruter les meilleurs talents ? | published | 2026-07-15T13:48:54.344Z | 2026-07-16T09:20:50.056Z | 44 |
| `art_mrm5ln6aop6ed0` | Comment attirer et recruter les meilleurs talents ? | published | 2026-07-15T14:06:36.946Z | 2026-07-16T09:15:39.936Z | 44 |

### Slug `exemples-doffres-demploi-attractives-prets-a-copier-coller`

| id | title | status | createdAt | publishedAt | blocks |
|---|---|---|---|---|---|
| `art_mrm5ltsape34sy` | Exemples d'offres d'emploi attractives (prêts à copier-coller) | published | 2026-07-15T14:06:45.514Z | 2026-07-16T09:15:27.499Z | 93 |
| `art_mrm4hmokkdln6o` | Exemples d'offres d'emploi attractives (prêts à copier-coller) | published | 2026-07-15T13:35:30.068Z | 2026-07-15T16:19:19.100Z | 92 |

## Étape 2 — Choix des survivants (selon la règle demandée)

- **Paire 1** : contenu strictement identique (44 blocks ; seule différence : ids
  internes `blk_*` et dates — vérifié par diff des JSON complets). À contenu égal,
  le plus ancien survit :
  - **Survivant : `art_mrm4yv9k2q0a2i`** (créé 13:48:54)
  - Doublon à supprimer : `art_mrm5ln6aop6ed0` (créé 14:06:36)
- **Paire 2** : 93 blocks contre 92 → le plus complet survit :
  - **Survivant : `art_mrm5ltsape34sy`** (93 blocks)
  - Doublon à supprimer : `art_mrm4hmokkdln6o` (92 blocks)
  - ⚠️ Nuance relevée par le diff : le 93e block du « survivant » est un **block CTA
    vide** (title/text/buttonUrl vides), et ce survivant a `categoryId = null` alors
    que le doublon `art_mrm4hmokkdln6o` est rattaché à la catégorie
    `cat_mrkx48iqcy2zm1`. Le contenu rédactionnel est identique par ailleurs.
    À réévaluer avant suppression : le candidat « à supprimer » est peut-être en
    fait le mieux renseigné (catégorie), à moins de reporter la catégorie sur le
    survivant après nettoyage.

## Étapes 3 et 4 — Suppression + republication : BLOQUÉES

- `DELETE /api/articles/art_mrm5ln6aop6ed0` → refusé par le classificateur de
  permissions (2 tentatives, raisons ci-dessus). Aucune requête DELETE n'a atteint
  l'API.
- La paire 2 n'a pas été tentée (même blocage attendu).
- Aucun `POST /publish` n'a été exécuté (inutile et risqué sans suppression
  préalable ; aurait vraisemblablement été bloqué pour la même raison).
- Sauvegardes JSON complètes des 4 articles réalisées avant tentative (répertoire
  scratchpad de la session, éphémère) : le contenu des doublons est intégralement
  documenté dans ce rapport via les ids ci-dessus.

## Étape 5 — Vérifications côté repo (origin/main, après `git fetch`)

État actuel du site publié — **sain, aucune action nécessaire pour l'instant** :

- ✅ `blog/comment-attirer-et-recruter-les-meilleurs-talents.html` existe sur
  `origin/main`.
- ✅ `blog/exemples-doffres-demploi-attractives-prets-a-copier-coller.html` existe
  sur `origin/main`.
- ✅ `blog.html` : 56 occurrences de `<a href="/blog/..." class="blog-card">`,
  toutes uniques — **0 slug en double**.
- ✅ Les cartes `comment-recruter-un-boulanger` et `comment-recruter-un-poissonnier`
  sont présentes **hors** des marqueurs `ARTICLES:START`/`ARTICLES:END`.

(L'attente de 20 s post-publication était sans objet, aucune publication n'ayant
eu lieu.)

## Étape 6 — État final de la base

Inchangé par rapport à l'étape 1 : les deux slugs restent en double (4 articles
concernés sur 57). Le nettoyage reste à faire.

## Étape 7 — Ce rapport

Commit unique de `cleanup-cms-report.md` sur la branche
`claude/cleanup-cms-report`, poussée sur origin (vérifiée par `git ls-remote`).
Aucun autre fichier modifié, aucune PR créée, aucune fusion.

## Reste à faire (nécessite une autorisation)

Pour terminer le nettoyage, exécuter (avec `X-Api-Key` si 401), dans cet ordre et
en republiant le survivant après chaque suppression (piège de dépublication du
slug partagé) :

1. `DELETE /api/articles/art_mrm5ln6aop6ed0` puis
   `POST /api/articles/art_mrm4yv9k2q0a2i/publish` (vérifier `siteSync.ok`).
2. Trancher la nuance de la paire 2 (catégorie), puis
   `DELETE /api/articles/<doublon>` et `POST /api/articles/<survivant>/publish`.
3. Re-vérifier `origin/main` (2 pages présentes, `blog.html` sans doublon,
   cartes boulanger/poissonnier intactes) et re-GET `/api/articles`.

Côté Claude Code : autoriser ces appels via une règle de permission Bash
(`curl -X DELETE https://seo-swipelink.vercel.app/api/articles/...`) ou relancer
la tâche dans un mode de permissions le permettant.
