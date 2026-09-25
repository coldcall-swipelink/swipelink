# Chat « Hugo, Céline et Lucas sont en ligne »

La bulle en bas à droite (`assets/script.js`, section « chat ») envoie chaque
message à `api/chat.js`, qui exige prénom, nom et e-mail, l'envoie par e-mail
et l'archive dans Supabase.

## Variables Vercel (Production ET Preview)

Le plus simple et sans service tiers : **votre propre boîte mail**.

1. Sur le compte qui enverra (ex. hugo@swipelink.fr), activer la validation en
   deux étapes, puis créer un « mot de passe d'application » (Google :
   myaccount.google.com/apppasswords).
2. Dans Vercel, projet swipelink, Settings, Environment Variables :
   `SMTP_USER` = l'adresse, `SMTP_PASS` = le mot de passe d'application.
3. Redéployer. Les messages arrivent chez hugo@ et bilal@ (reply-to sur le visiteur).

| Variable | Rôle |
|---|---|
| `SMTP_USER`, `SMTP_PASS` | votre boîte mail qui envoie (mot de passe d'application) |
| `SMTP_HOST`, `SMTP_PORT` | facultatif — défaut Gmail/Google Workspace (`smtp.gmail.com`, 465) ; Outlook/Microsoft 365 : `smtp.office365.com`, 587 ; OVH : `ssl0.ovh.net`, 465 |
| `WEB3FORMS_KEY` | alternative : clé Web3Forms (les autres destinataires en copie) |
| `RESEND_API_KEY`, `CHAT_FROM` | alternative : Resend, domaine `swipelink.fr` vérifié |
| `CHAT_TO` | destinataires, séparés par des virgules — défaut `hugo@swipelink.fr, bilal@swipelink.fr` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | déjà en place pour les candidatures ; servent à l'archivage |

Ordre d'essai : SMTP, puis Web3Forms, puis Resend. Sans aucun des trois, les
messages sont seulement archivés (réponse succès au visiteur, avertissement
dans les logs). Sans Supabase ni fournisseur, le widget affiche un message
d'indisponibilité avec l'adresse contact.

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
