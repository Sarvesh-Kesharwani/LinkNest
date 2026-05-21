# LinkNest Bot

Telegram bot that saves links/text to LinkNest, can move recent text into ChatThoughts, and can forward AI-parsed link intents into Tubeo.

- `/linknest <note>` — save a quick text note to the **LinkNest** Supabase project (`linknest_notes` table).
- `/thought <text>` — save a raw thought to the **ChatThoughts** Supabase project (`chatthoughts_thoughts` table). The web app at https://chatthoughts.vercel.app re-augments these on first edit.
- `/archive [query]` — read/search the legacy `saved_links` archive from Telegram. `/legacy [query]` is an alias.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. **LinkNest Supabase** — run `supabase-schema.sql` in the SQL editor (idempotent; creates `saved_links` legacy + `linknest_notes`).
3. **ChatThoughts Supabase** — already provisioned in the `todotrails` project. The bot writes into `chatthoughts_thoughts` directly.
4. Copy `.env.example` → `.env` and fill values.
5. **Tubeo ingest** - optional. Set `TUBEO_API_URL` and the same `TUBEO_TELEGRAM_INGEST_SECRET` as Tubeo to save links to Tubeo Watch Later, update notes, and add YouTube channels.
6. Run:

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
| `LEGACY_LINKS_TABLE` | Default `saved_links` |
| `LEGACY_ARCHIVE_FETCH_LIMIT` | Default `200`; max legacy rows fetched before in-bot filtering |
| `CHATTHOUGHTS_SUPABASE_URL` / `CHATTHOUGHTS_SUPABASE_KEY` | ChatThoughts project (for `/thought`) |
| `CHATTHOUGHTS_TABLE` | Default `chatthoughts_thoughts` |
| `TUBEO_API_URL` / `TUBEO_TELEGRAM_INGEST_SECRET` | Tubeo ingest endpoint + shared secret |
| `TUBEO_ALLOWED_TELEGRAM_USER_IDS` | Optional comma-separated allowlist |
| `BOT_MODE` | `polling` (dev) or `webhook` (Render) |

## Deploy (Render)

`render.yaml` describes the service. Push to `main` → Render auto-deploys.
