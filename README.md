# LinkNest Bot

Telegram bot that classifies every message before acting. It saves links to LinkNest, thoughts to ChatThoughts, lists saved records, and can forward explicit YouTube-channel save requests into Tubeo.

- Bare links are not auto-saved; the bot asks what to do.
- "Save this link ..." writes to LinkNest `saved_links`, so Tubeo can import it from the shared LinkNest project.
- "Save this thought/note ..." writes to the ChatThoughts table.
- "List saved links" shows LinkNest links with notes.
- "List saved thoughts" shows ChatThought records with titles.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. **LinkNest Supabase** - run `supabase-schema.sql` in the SQL editor (idempotent; creates `saved_links`, `linknest_notes`, and `linknest_conversations`).
3. **ChatThoughts Supabase** - already provisioned in the `todotrails` project. The bot writes into `chatthoughts_thoughts` directly.
4. Copy `.env.example` to `.env` and fill values.
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
| `SUPABASE_URL` / `SUPABASE_KEY` | LinkNest project for links and bot memory |
| `LINKNEST_TABLE` | Default `linknest_notes` |
| `LEGACY_LINKS_TABLE` | Default `saved_links` |
| `LINKNEST_CONVERSATION_TABLE` | Default `linknest_conversations` |
| `LEGACY_ARCHIVE_FETCH_LIMIT` | Default `200`; max legacy rows fetched before in-bot filtering |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | Optional AI replies and conversation summarization |
| `CHATTHOUGHTS_SUPABASE_URL` / `CHATTHOUGHTS_SUPABASE_KEY` | ChatThoughts project for thought saves |
| `CHATTHOUGHTS_TABLE` | Default `chatthoughts_thoughts` |
| `CHATTHOUGHTS_SCHEMA` | Optional; use `chatthoughts` with table `thoughts` |
| `CHATTHOUGHTS_NEED_COLUMN` / `CHATTHOUGHTS_TITLE_COLUMN` | Defaults `when_needed` / `mantra`; use `need_when` / `mantra` for `chatthoughts.thoughts` |
| `TUBEO_API_URL` / `TUBEO_TELEGRAM_INGEST_SECRET` | Tubeo ingest endpoint + shared secret |
| `TUBEO_ALLOWED_TELEGRAM_USER_IDS` | Optional comma-separated allowlist |
| `BOT_MODE` | `polling` (dev) or `webhook` (Render) |

## Deploy (Render)

`render.yaml` describes the service. Push to `main` and Render auto-deploys.
