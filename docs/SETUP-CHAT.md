# Chat « Hugo, Céline et Lucas sont en ligne »

La bulle en bas à droite (`assets/script.js`, section « chat ») envoie chaque
message à `api/chat.js`, qui exige prénom, nom et e-mail, l'envoie par e-mail
et l'archive dans Supabase.

## Variables Vercel (Production ET Preview)

Le plus simple : **Web3Forms**, aucun réglage DNS.

1. Sur web3forms.com, saisir `hugo@swipelink.fr` : la clé (« access key ») arrive par e-mail.
2. Dans Vercel, projet swipelink, Settings, Environment Variables : `WEB3FORMS_KEY` = cette clé.
3. Redéployer. Les messages arrivent chez hugo@ avec bilal@ en copie.

| Variable | Rôle |
|---|---|
| `WEB3FORMS_KEY` | clé Web3Forms liée à l'adresse qui reçoit (les autres destinataires sont en copie) |
| `RESEND_API_KEY` | alternative : clé Resend, avec le domaine `swipelink.fr` vérifié |
| `CHAT_TO` | destinataires, séparés par des virgules — défaut `hugo@swipelink.fr, bilal@swipelink.fr` (rien à régler pour ces deux-là) |
| `CHAT_FROM` | expéditeur Resend — défaut `Chat Swipelink <chat@swipelink.fr>` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | déjà en place pour les candidatures ; servent à l'archivage |

Web3Forms est essayé en premier, Resend ensuite. Sans aucun des deux, les
messages sont seulement archivés (réponse succès au visiteur, avertissement
dans les logs). Sans Supabase ni fournisseur d'e-mail, le widget affiche un
message d'indisponibilité avec l'adresse contact.

## Table d'archivage (SQL, une fois)

```sql
create table if not exists site_chat_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  prenom text not null, nom text not null, email text not null,
  message text not null, page text, ip text
);
alter table site_chat_messages enable row level security; -- la clé service passe outre
```

## Le prénom

Les prénoms et photos (`assets/chat/*.webp`, 160×160) sont dans `assets/script.js` (constantes `CHAT_TEAM` et `TEAM_LABEL`).
