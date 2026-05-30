# Tubeo Telegram Bot

Telegram bot that stores shared links directly in Tubeo tables inside the TodoTrails/Turo Supabase project.

- Any link sent to the bot is saved to Tubeo Watch Later.
- After a bare link, the bot asks for a note and attaches the next text message to that link.
- If the same link is sent again with a different note, the existing Watch Later item is updated.
- Notes can also be included in the same message, e.g. `https://youtu.be/... note, funny comedy pakistaani accent`.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. In the TodoTrails/Turo Supabase project, run:
   - `D:\Tubeo\docs\supabase-saved-videos-schema.sql`
3. Copy `.env.example` to `.env` and fill values.
4. Run:

```bash
npm install
npm run dev
```

## Env Vars

| Key | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TUBEO_SUPABASE_URL` | TodoTrails/Turo Supabase project URL |
| `TUBEO_SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service role key |
| `TUBEO_SUPABASE_SAVED_VIDEOS_TABLE` | Default `tubeo_saved_videos` |
| `TUBEO_TELEGRAM_OWNER_EMAIL` | Tubeo account email whose Watch Later data should be updated |
| `TUBEO_TELEGRAM_OWNER_NAME` | Optional display name |
| `BOT_MODE` | `polling` locally, `webhook` on Render |

## Deploy

`render.yaml` describes the Render service. Push to `main`; Render auto-deploys if linked.
