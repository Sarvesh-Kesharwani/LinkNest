import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { Bot, webhookCallback } from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const linknestUrl = requiredEnv("SUPABASE_URL");
const linknestKey =
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!linknestKey) {
  throw new Error("Missing required env var: SUPABASE_KEY");
}
const linknestTable = process.env.LINKNEST_TABLE || "linknest_notes";

const chatthoughtsUrl = process.env.CHATTHOUGHTS_SUPABASE_URL;
const chatthoughtsKey =
  process.env.CHATTHOUGHTS_SUPABASE_KEY ||
  process.env.CHATTHOUGHTS_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.CHATTHOUGHTS_SUPABASE_ANON_KEY;
const chatthoughtsTable =
  process.env.CHATTHOUGHTS_TABLE || "chatthoughts_thoughts";

const botMode =
  process.env.BOT_MODE || (process.env.RENDER ? "webhook" : "polling");
const port = Number(process.env.PORT || 10000);

const bot = new Bot(telegramToken);

const linknest: SupabaseClient = createClient(linknestUrl, linknestKey, {
  auth: { persistSession: false },
});

const chatthoughts: SupabaseClient | null =
  chatthoughtsUrl && chatthoughtsKey
    ? createClient(chatthoughtsUrl, chatthoughtsKey, {
        auth: { persistSession: false },
      })
    : null;

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Two commands:",
      "/linknest <note>  — save a quick note to LinkNest",
      "/thought  <text>  — save a thought to ChatThoughts",
    ].join("\n"),
  );
});

bot.command("linknest", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply("Use: /linknest <your note>");
    return;
  }
  const sender = ctx.from;
  if (!sender) {
    await ctx.reply("Could not identify sender.");
    return;
  }
  const { error } = await linknest.from(linknestTable).insert({
    sender_id: sender.id,
    sender_username: sender.username ?? null,
    chat_id: ctx.chat.id,
    text: text.slice(0, 5000),
  });
  if (error) {
    console.error("linknest save failed", error);
    await ctx.reply(`Save failed: ${error.message}`);
    return;
  }
  await ctx.reply("Saved to LinkNest.");
});

bot.command("thought", async (ctx) => {
  if (!chatthoughts) {
    await ctx.reply(
      "ChatThoughts is not configured on this bot (missing CHATTHOUGHTS_SUPABASE_URL / KEY).",
    );
    return;
  }
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply("Use: /thought <your thought>");
    return;
  }
  const trimmed = text.slice(0, 5000);
  // ChatThoughts encodes the augmented JSON inside the `mantra` column. We
  // skip AI augmentation from the bot for speed — the web app re-augments on
  // first edit. Format mirrors `encodeAugmented` in the Next.js app.
  const mantra = JSON.stringify({ short: trimmed, _raw: trimmed });
  const { error } = await chatthoughts.from(chatthoughtsTable).insert({
    when_needed: null,
    mantra,
  });
  if (error) {
    console.error("thought save failed", error);
    await ctx.reply(`Save failed: ${error.message}`);
    return;
  }
  await ctx.reply("Saved to ChatThoughts.");
});

bot.catch((err) => {
  console.error("bot error", err);
});

if (botMode === "webhook") {
  await startWebhookServer();
} else {
  await bot.api.deleteWebhook();
  await registerBotCommands();
  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot polling as @${botInfo.username}`);
    },
  });
}

async function startWebhookServer(): Promise<void> {
  const app = express();
  const webhookPath = `/telegram/${getWebhookSecret()}`;
  const externalUrl =
    process.env.TELEGRAM_WEBHOOK_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`;

  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "LinkNest bot" });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.json());
  app.post(webhookPath, webhookCallback(bot, "express"));

  app.listen(port, "0.0.0.0", async () => {
    const webhookUrl = `${externalUrl}${webhookPath}`;
    await registerBotCommands();
    await bot.api.setWebhook(webhookUrl);
    const botInfo = await bot.api.getMe();
    console.log(`Bot webhook running as @${botInfo.username}`);
    console.log(`Webhook set: ${webhookUrl}`);
  });
}

async function registerBotCommands(): Promise<void> {
  // setMyCommands fully replaces the previously registered list — old
  // commands (/help, /ask, /note, /skip ...) are removed automatically.
  await bot.api.setMyCommands([
    { command: "linknest", description: "Save a note to LinkNest" },
    { command: "thought", description: "Save a thought to ChatThoughts" },
    { command: "start", description: "Show usage" },
  ]);
}

function getWebhookSecret(): string {
  return (
    process.env.WEBHOOK_SECRET ||
    telegramToken.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
