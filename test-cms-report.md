# Rapport de test — chaîne de publication CMS SwipeLink SEO → site vitrine

- **Date** : 2026-09-21 (UTC)
- **CMS testé** : https://seo-swipelink.vercel.app
- **Repo cible** : coldcall-swipelink/swipelink (branche `main`)
- **Article de test** : `test-pipeline-cms` (id `art_muazpc1bftku9l`), créé puis dépublié et supprimé pendant le test.

## Étape 1 — GET /api/articles

- **HTTP 200**. L'API répond, **57 articles** retournés (56 `published`, 1 `draft` : `conseils-et-methodes-recrutement-en-grande-distribution`).
- Aucune authentification requise (pas de 401 rencontré sur toute la session ; l'étape 7 avec `X-Api-Key` n'a pas été nécessaire).

## Étape 2 — POST /api/articles (création du brouillon)

- **HTTP 201**. Réponse (essentiel) :
  ```json
  {"id":"art_muazpc1bftku9l","slug":"test-pipeline-cms","status":"draft","createdAt":"2026-09-21T08:35:10.511Z"}
  ```

## Étape 3 — POST /api/articles/art_muazpc1bftku9l/publish

- **HTTP 200**, `status: "published"`, `publishedAt: "2026-09-21T08:35:21.167Z"`.
- **`siteSync: {"ok": true}`** ← cœur du test : la synchronisation vers le site a réussi.

## Étape 4 — Vérification du repo après publication (~15 s)

`git fetch origin main` a ramené deux nouveaux commits (01376a7 → 95a85ca) :

```
95a85ca blog: met à jour la liste des articles
32d28d6 blog: publie « Test technique du pipeline (à supprimer) »
```

- `git show origin/main:blog/test-pipeline-cms.html` : fichier présent, HTML valide (`<!DOCTYPE html>`, `<html lang="fr-FR">`…).
- `blog.html` sur `origin/main` : la carte de test est bien présente **entre les marqueurs ARTICLES:START/END** (`<a href="/blog/test-pipeline-cms" class="blog-card">` avec le titre « Test technique du pipeline (à supprimer) »).

## Étape 5 — POST /api/articles/art_muazpc1bftku9l/unpublish

- **HTTP 200**, `status: "draft"`.
- **`siteSync: {"ok": true}`**.

Vérification du repo après ~15 s (`git fetch origin main`, 95a85ca → fcd1336) :

```
fcd1336 blog: met à jour la liste des articles
36c77eb blog: retire « Test technique du pipeline (à supprimer) »
```

- `blog/test-pipeline-cms.html` : **absent** de `origin/main` (OK).
- Carte de test dans `blog.html` : **absente** (OK).

## Étape 6 — DELETE /api/articles/art_muazpc1bftku9l

- **HTTP 200**, réponse `{"ok":true}`. La méthode DELETE est supportée.
- Re-GET `/api/articles` : **HTTP 200**, le slug `test-pipeline-cms` n'apparaît plus (0 occurrence). Le CMS est revenu à son état initial (57 articles d'origine).

## Étape 7 — Authentification

- Aucune requête n'a renvoyé 401 : la clé API n'était pas requise pendant ce test.

## Conclusion

**Chaîne OK.** Le cycle complet création → publication (commit + fichier `blog/<slug>.html` + carte dans `blog.html`) → dépublication (retrait du fichier et de la carte) → suppression fonctionne de bout en bout, avec `siteSync.ok = true` à la publication et à la dépublication, et des commits arrivés sur `origin/main` en moins de 15 secondes.
