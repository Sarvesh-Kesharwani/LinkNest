# Telegram Link Saver Bot

Saves Instagram Reel/Post and YouTube/Shorts URLs from Telegram messages into Supabase.

## Setup

1. Create bot in Telegram with `@BotFather`, copy token.
2. Create Supabase table using `supabase-schema.sql`.
3. Copy `.env.example` to `.env` and fill values.
4. Run:

```bash
npm install
npm run dev
```

## Use

Send bot any message containing Instagram or YouTube URLs.

Supported:

- `https://www.instagram.com/reel/...`
- `https://www.instagram.com/p/...`
- `https://youtube.com/shorts/...`
- `https://youtube.com/watch?v=...`
- `https://youtu.be/...`

Duplicates are blocked per Telegram sender.
