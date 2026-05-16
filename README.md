# LinkNest Bot

Telegram bot with two commands:

- `/linknest <note>` — save a quick text note to the **LinkNest** Supabase project (`linknest_notes` table).
- `/thought <text>` — save a raw thought to the **ChatThoughts** Supabase project (`chatthoughts_thoughts` table). The web app at https://chatthoughts.vercel.app re-augments these on first edit.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. **LinkNest Supabase** — run `supabase-schema.sql` in the SQL editor (idempotent; creates `saved_links` legacy + `linknest_notes`).
3. **ChatThoughts Supabase** — already provisioned in the `todotrails` project. The bot writes into `chatthoughts_thoughts` directly.
4. Copy `.env.example` → `.env` and fill values.
5. Run:

```bash
npm install
npm run dev
```

Keep all Supabase keys server-only.

## Env vars

| Key | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `SUPABASE_URL` / `SUPABASE_KEY` | LinkNest project (for `/linknest`) |
| `LINKNEST_TABLE` | Default `linknest_notes` |
| `CHATTHOUGHTS_SUPABASE_URL` / `CHATTHOUGHTS_SUPABASE_KEY` | ChatThoughts project (for `/thought`) |
| `CHATTHOUGHTS_TABLE` | Default `chatthoughts_thoughts` |
| `BOT_MODE` | `polling` (dev) or `webhook` (Render) |

## Deploy (Render)

`render.yaml` describes the service. Push to `main` → Render auto-deploys.
