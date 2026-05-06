# LinkLoom Bot

Telegram bot that saves any URL into Supabase, asks for a note, and lets you query saved links with DeepSeek.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. Create new Supabase project.
3. Run `supabase-schema.sql` in Supabase SQL Editor.
4. Supabase Project Settings -> API:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_KEY` = service role secret key, or publishable key if using the included RLS policies
5. DeepSeek dashboard -> create API key.
6. Copy `.env.example` to `.env` and fill values.
7. Run:

```bash
npm install
npm run dev
```

Keep `SUPABASE_KEY` and `DEEPSEEK_API_KEY` server-only. Never expose them in browser code.

## Use

Send any message containing links. Bot saves them, then asks for a note.

Supported:

- `https://www.instagram.com/reel/...`
- `https://youtube.com/shorts/...`
- any webpage link

Duplicates are blocked per Telegram sender.

Commands:

- `/start` setup hint
- `/skip` skip note for last saved links
- `/ask cooking reels` query saved links with DeepSeek
- `? cooking reels` same as `/ask`
