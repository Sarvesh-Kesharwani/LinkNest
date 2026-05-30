import "dotenv/config";
import express from "express";
import { Bot, Context, webhookCallback } from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const botMode =
  process.env.BOT_MODE || (process.env.RENDER ? "webhook" : "polling");
const port = Number(process.env.PORT || 10000);

const tubeoConfig = {
  url: requiredEnv("TUBEO_SUPABASE_URL").replace(/\/+$/, ""),
  key:
    process.env.TUBEO_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.TUBEO_SUPABASE_SECRET_KEY?.trim() ||
    requiredEnv("TUBEO_SUPABASE_SERVICE_ROLE_KEY"),
  savedVideosTable:
    process.env.TUBEO_SUPABASE_SAVED_VIDEOS_TABLE?.trim() ||
    "tubeo_saved_videos",
  ownerEmail: requiredEnv("TUBEO_TELEGRAM_OWNER_EMAIL").trim().toLowerCase(),
  ownerName: process.env.TUBEO_TELEGRAM_OWNER_NAME?.trim() || null,
};

type BotContext = Context;

interface SavedVideo {
  id: string;
  url: string;
  note: string;
  category: string;
  addedAt: string;
}

interface SavedVideosRow {
  owner_key: string;
  user_email: string;
  user_name: string | null;
  videos: SavedVideo[];
  videos_updated_at: string;
}

interface ChatState {
  pendingNoteUrl?: string;
}

const bot = new Bot<BotContext>(telegramToken);
const stateByChat = new Map<string, ChatState>();
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const DEFAULT_CATEGORY = "Uncategorized";

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;

  try {
    await handleMessage(ctx, text);
  } catch (error) {
    await ctx.reply(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.catch((err) => {
  console.error("bot error", err);
});

if (botMode === "webhook") {
  await startWebhookServer();
} else {
  await bot.api.deleteWebhook();
  await bot.api.setMyCommands([]);
  await bot.start({
    onStart: (botInfo) => console.log(`Bot polling as @${botInfo.username}`),
  });
}

async function handleMessage(ctx: BotContext, text: string): Promise<void> {
  const chatState = getChatState(ctx);
  const url = extractFirstUrl(text);

  if (url) {
    const note = extractInlineNote(text, url);
    const saved = await upsertSavedVideo(url, note);
    chatState.pendingNoteUrl = saved.url;

    if (note) {
      await ctx.reply(`${saved.existed ? "Updated" : "Saved"} Watch Later with note.\n${saved.url}`);
      return;
    }

    await ctx.reply(`${saved.existed ? "Already saved" : "Saved"} Watch Later.\nSend the note for this link.`);
    return;
  }

  if (chatState.pendingNoteUrl) {
    const saved = await upsertSavedVideo(chatState.pendingNoteUrl, text);
    chatState.pendingNoteUrl = undefined;
    await ctx.reply(`${saved.existed ? "Updated note" : "Saved note"}.\n${saved.url}`);
    return;
  }

  await ctx.reply("Send a link to save to Tubeo Watch Later.");
}

async function readSavedVideos(): Promise<SavedVideo[]> {
  const qs = new URLSearchParams({
    owner_key: `eq.${ownerKey()}`,
    select: "videos",
    limit: "1",
  });
  const res = await tubeoFetch(`${tableUrl(tubeoConfig.savedVideosTable)}?${qs}`);
  if (!res.ok) throw new Error(await errorText(res, "saved-videos read failed"));
  const rows = (await res.json()) as Array<{ videos?: SavedVideo[] }>;
  return normalizeVideos(rows[0]?.videos || []);
}

async function writeSavedVideos(videos: SavedVideo[]): Promise<void> {
  const now = new Date().toISOString();
  const row: SavedVideosRow = {
    owner_key: ownerKey(),
    user_email: tubeoConfig.ownerEmail,
    user_name: tubeoConfig.ownerName,
    videos: normalizeVideos(videos),
    videos_updated_at: now,
  };
  const qs = new URLSearchParams({ on_conflict: "owner_key" });
  const res = await tubeoFetch(`${tableUrl(tubeoConfig.savedVideosTable)}?${qs}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(await errorText(res, "saved-videos write failed"));
}

async function upsertSavedVideo(
  rawUrl: string,
  note = "",
): Promise<{ url: string; existed: boolean }> {
  const resolved = resolveSavedVideoFromUrl(rawUrl);
  if (!resolved) throw new Error("Not a valid link.");

  const current = await readSavedVideos();
  const existing = current.find((video) => video.id === resolved.id);
  const cleanNote = note.trim();
  const saved: SavedVideo = {
    id: resolved.id,
    url: resolved.url,
    note: cleanNote || existing?.note || "",
    category: existing?.category || DEFAULT_CATEGORY,
    addedAt: existing?.addedAt || new Date().toISOString(),
  };

  await writeSavedVideos([saved, ...current.filter((video) => video.id !== resolved.id)]);
  return { url: saved.url, existed: Boolean(existing) };
}

function normalizeVideos(videos: SavedVideo[]): SavedVideo[] {
  const seen = new Set<string>();
  const out: SavedVideo[] = [];
  for (const video of videos) {
    if (!video?.id || !video?.url || seen.has(video.id)) continue;
    seen.add(video.id);
    out.push({
      id: video.id,
      url: video.url,
      note: typeof video.note === "string" ? video.note.trim() : "",
      category: video.category || DEFAULT_CATEGORY,
      addedAt: video.addedAt || new Date().toISOString(),
    });
  }
  return out;
}

function resolveSavedVideoFromUrl(raw: string): { id: string; url: string } | null {
  const clean = canonicalizeUrl(raw);
  const youtubeId = parseYouTubeVideoId(clean);
  if (youtubeId) return { id: youtubeId, url: `https://www.youtube.com/watch?v=${youtubeId}` };

  try {
    const url = new URL(clean);
    if (url.hostname.includes("instagram.com")) {
      const shortcode = url.pathname.split("/").filter(Boolean)[1] || stableUrlId(clean);
      return { id: `ig_${shortcode}`, url: clean };
    }
    return { id: `wp_${stableUrlId(clean)}`, url: clean };
  } catch {
    return null;
  }
}

function parseYouTubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
    return marker >= 0 ? parts[marker + 1] || null : null;
  } catch {
    return null;
  }
}

function extractFirstUrl(text?: string): string | undefined {
  return text?.match(URL_RE)?.[0]?.replace(/[),.;!?]+$/g, "");
}

function extractInlineNote(text: string, url: string): string {
  return text.replace(url, "").replace(/\bnote\b[:,\s-]*/i, "").trim();
}

function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "igshid",
      "si",
    ]) {
      url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

function stableUrlId(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 48);
}

function getChatState(ctx: BotContext): ChatState {
  const key = `${ctx.chat?.id || "nochat"}:${ctx.from?.id || "nouser"}`;
  let state = stateByChat.get(key);
  if (!state) {
    state = {};
    stateByChat.set(key, state);
  }
  return state;
}

function tableUrl(table: string): string {
  return `${tubeoConfig.url}/rest/v1/${encodeURIComponent(table)}`;
}

function ownerKey(): string {
  return `google:${tubeoConfig.ownerEmail}`;
}

function tubeoFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      apikey: tubeoConfig.key,
      Authorization: `Bearer ${tubeoConfig.key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
}

async function errorText(res: Response, prefix: string): Promise<string> {
  return `${prefix}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 240)}`;
}

async function startWebhookServer(): Promise<void> {
  const app = express();
  const webhookPath = `/telegram/${getWebhookSecret()}`;
  const externalUrl =
    process.env.TELEGRAM_WEBHOOK_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${port}`;

  app.get("/", (_req, res) => res.json({ ok: true, service: "Tubeo Telegram bot" }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.json());
  app.post(webhookPath, webhookCallback(bot, "express"));

  app.listen(port, "0.0.0.0", async () => {
    await bot.api.setMyCommands([]);
    await bot.api.setWebhook(`${externalUrl}${webhookPath}`);
    const botInfo = await bot.api.getMe();
    console.log(`Bot webhook running as @${botInfo.username}`);
  });
}

function getWebhookSecret(): string {
  return (
    process.env.WEBHOOK_SECRET ||
    telegramToken.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
