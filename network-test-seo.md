# Test d'accès réseau sortant — domaines SEO / sources officielles

**Date du test :** 2026-09-20 11:45 UTC
**Environnement :** session Claude Code distante (conteneur isolé, sortie HTTPS via proxy egress)
**Méthode :** `curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -L https://<domaine>/` + outil WebFetch pour 4 domaines témoins.

## Résultats

| Domaine | Résultat curl | Résultat WebFetch |
|---|---|---|
| insee.fr | ❌ Bloqué — rc=56 (connexion coupée par le proxy, redir. vers www.insee.fr) | ❌ EGRESS_BLOCKED (`Access to www.insee.fr is blocked by the network egress proxy.`) |
| www.insee.fr | ❌ Bloqué — rc=56 (connexion coupée par le proxy) | — |
| dares.travail-emploi.gouv.fr | ✅ HTTP 200 | — |
| travail-emploi.gouv.fr | ✅ HTTP 200 | — |
| code.travail.gouv.fr | ✅ HTTP 200 | — |
| legifrance.gouv.fr | ❌ Bloqué — rc=56 (redir. vers www.legifrance.gouv.fr, connexion coupée) | ❌ EGRESS_BLOCKED (`Access to www.legifrance.gouv.fr is blocked by the network egress proxy.`) |
| service-public.fr | ❌ Bloqué — rc=56 (redir. vers www.service-public.fr, connexion coupée) | ❌ EGRESS_BLOCKED (`Access to www.service-public.fr is blocked by the network egress proxy.`) |
| francetravail.org | ❌ Bloqué — rc=56 (redir. vers www.francetravail.org/accueil/, connexion coupée) | ❌ EGRESS_BLOCKED (`Access to www.francetravail.org is blocked by the network egress proxy.`) |
| francetravail.fr | ❌ Bloqué — rc=56 (redir. vers www.francetravail.fr/accueil/, connexion coupée) | — |
| candidat.francetravail.fr | ✅ HTTP 200 (redir. vers /espacepersonnel/) | — |
| apec.fr | ❌ Bloqué — rc=56 (redir. vers www.apec.fr, connexion coupée) | — |
| urssaf.fr | ❌ Bloqué — rc=60 (échec de vérification du certificat via le proxy) | — |
| francecompetences.fr | ❌ Bloqué — rc=56 (redir. vers www.francecompetences.fr, connexion coupée) | — |
| onisep.fr | ⚠️ HTTP 403 (réponse reçue sur http://www.onisep.fr/ — accès refusé par le site ou le proxy) | — |
| lopcommerce.com | ❌ Bloqué — rc=52 (réponse vide du serveur/proxy) | — |
| cma-france.fr | ⚠️ HTTP 429 (redir. vers artisanat.fr — trop de requêtes / limitation) | — |
| fcd.fr | ❌ Bloqué — rc=56 (redir. vers www.fcd.fr, connexion coupée) | — |
| cgad.fr | ❌ Bloqué — rc=56 (redir. vers www.cgad.fr, connexion coupée) | — |
| boucherie-france.org | ❌ Bloqué — rc=56 (redir. vers www.boucherie-france.org, connexion coupée) | — |
| boulangerie.org | ✅ HTTP 200 | — |
| fict.fr | ❌ Bloqué — rc=56 (redir. vers www.fict.fr, connexion coupée) | — |
| franceagrimer.fr | ❌ Bloqué — rc=56 (connexion coupée) | — |
| interbev.fr | ⚠️ HTTP 403 (réponse reçue sur http://www.interbev.fr/ — accès refusé) | — |

## Synthèse

- **Accessibles (HTTP 200) :** dares.travail-emploi.gouv.fr, travail-emploi.gouv.fr, code.travail.gouv.fr, candidat.francetravail.fr, boulangerie.org — soit 5 domaines sur 23.
- **Bloqués par le proxy egress (curl rc=56/52/60, HTTP 000) :** insee.fr, www.insee.fr, legifrance.gouv.fr, service-public.fr, francetravail.org, francetravail.fr, apec.fr, urssaf.fr, francecompetences.fr, lopcommerce.com, fcd.fr, cgad.fr, boucherie-france.org, fict.fr, franceagrimer.fr — soit 15 domaines. Les 4 domaines témoins testés via WebFetch (insee.fr, francetravail.org, service-public.fr, legifrance.gouv.fr) retournent tous exactement `EGRESS_BLOCKED`, ce qui confirme que le blocage vient de la politique réseau de l'environnement et non des sites.
- **Réponse reçue mais accès refusé ou limité par le site :** onisep.fr (403), interbev.fr (403), cma-france.fr (429 après redirection vers artisanat.fr). Pour ces trois-là, le réseau passe mais le serveur distant refuse la requête (probable filtrage anti-bot).

Notes de lecture des codes curl : rc=56 = « Recv failure / connection reset » (le proxy coupe la connexion vers un domaine hors liste d'autorisation) ; rc=52 = réponse vide ; rc=60 = certificat non vérifiable (interception proxy sur domaine non autorisé). Dans tous ces cas le code HTTP affiché est 000 (aucune réponse HTTP reçue).
