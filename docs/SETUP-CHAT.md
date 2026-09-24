# Chat « Hugo est en ligne »

La bulle en bas à droite (`assets/script.js`, section « chat ») envoie chaque
message à `api/chat.js`, qui exige prénom, nom et e-mail, l'envoie par e-mail
et l'archive dans Supabase.

## Variables Vercel (Production ET Preview)

| Variable | Rôle |
|---|---|
| `RESEND_API_KEY` | clé API Resend (resend.com), avec le domaine `swipelink.fr` vérifié |
| `CHAT_TO` | destinataire des messages — défaut `contact@swipelink.fr` |
| `CHAT_FROM` | expéditeur — défaut `Chat Swipelink <chat@swipelink.fr>` (doit être sur le domaine vérifié) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | déjà en place pour les candidatures ; servent à l'archivage |

Sans `RESEND_API_KEY`, les messages sont seulement archivés (réponse succès
au visiteur, avertissement dans les logs). Sans Supabase ni Resend, le widget
affiche un message d'indisponibilité avec l'adresse contact.

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

« Hugo » et « en ligne » sont dans `assets/script.js` (constante `CHAT_AGENT`).
