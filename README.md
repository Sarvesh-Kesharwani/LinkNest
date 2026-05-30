# Tubeo Telegram Bot

Telegram bot that stores shared links directly in Tubeo tables inside the TodoTrails/Turo Supabase project.

- Bare links are never auto-saved; the bot asks whether to save as Watch Later video/link or YouTube channel.
- Watch Later saves write to `tubeo_saved_videos`.
- YouTube channels write to `tubeo_user_sync_state.state.channels`.
- Replying to a human or bot message with a link updates/saves that previous link.
- Notes can be included in the same message, e.g. `youtube video note, funny comedy pakistaani accent`.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. In the TodoTrails/Turo Supabase project, run:
   - `D:\Tubeo\docs\supabase-saved-videos-schema.sql`
   - `D:\Tubeo\docs\supabase-sync-schema.sql`
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
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | Optional classifier for natural follow-up messages |
| `YOUTUBE_API_KEY` | Required to resolve channel from YouTube video link or handle |
| `TUBEO_SUPABASE_URL` | TodoTrails/Turo Supabase project URL |
| `TUBEO_SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service role key |
| `TUBEO_SUPABASE_SYNC_TABLE` | Default `tubeo_user_sync_state` |
| `TUBEO_SUPABASE_SAVED_VIDEOS_TABLE` | Default `tubeo_saved_videos` |
| `TUBEO_TELEGRAM_OWNER_EMAIL` | Tubeo account email whose data should be updated |
| `TUBEO_TELEGRAM_OWNER_NAME` | Optional display name |
| `BOT_MODE` | `polling` locally, `webhook` on Render |

## Deploy

`render.yaml` describes the Render service. Push to `main`; Render auto-deploys if linked.
