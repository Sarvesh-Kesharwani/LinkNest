import "dotenv/config";
import express from "express";
import { Bot, Context, webhookCallback } from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
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
  syncTable:
    process.env.TUBEO_SUPABASE_SYNC_TABLE?.trim() || "tubeo_user_sync_state",
  ownerEmail: requiredEnv("TUBEO_TELEGRAM_OWNER_EMAIL").trim().toLowerCase(),
  ownerName: process.env.TUBEO_TELEGRAM_OWNER_NAME?.trim() || null,
};

type BotContext = Context;

type Intent =
  | { type: "save_video"; url?: string; note?: string }
  | { type: "save_channel"; url?: string; space?: string }
  | { type: "update_video_note"; url?: string; note?: string; mode?: "replace" | "append" }
  | { type: "list_videos" }
  | { type: "list_channels" }
  | { type: "clarify"; question: string };

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
  updated_at?: string;
}

interface ChannelPreference {
  id: string;
  space: string;
}

interface TubeoState {
  channels?: ChannelPreference[];
  spaces?: string[];
  view?: unknown;
  viewUpdatedAt?: string;
  updatesChannelIds?: string[];
  vocabs?: unknown[];
  ignoredChannels?: unknown[];
  discoverSearches?: unknown[];
  [key: string]: unknown;
}

interface SyncRow {
  owner_key: string;
  user_email: string;
  user_name: string | null;
  state: TubeoState;
  state_updated_at: string;
}

interface ChatMemory {
  userTurns: string[];
  botTurns: string[];
  lastUrl?: string;
  lastSavedVideoUrl?: string;
  lastChannelUrl?: string;
}

const bot = new Bot<BotContext>(telegramToken);
const memoryByChat = new Map<string, ChatMemory>();
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const DEFAULT_SPACE = "ALL";
const DEFAULT_CATEGORY = "Uncategorized";

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  await handleMessage(ctx, text);
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
  const replyText = getReplyText(ctx);
  rememberUserTurn(ctx, text);

  const intent = await classifyIntent(ctx, text, replyText);
  try {
    switch (intent.type) {
      case "save_video":
        await saveVideoFromIntent(ctx, text, replyText, intent);
        return;
      case "save_channel":
        await saveChannelFromIntent(ctx, text, replyText, intent);
        return;
      case "update_video_note":
        await updateVideoNoteFromIntent(ctx, text, replyText, intent);
        return;
      case "list_videos":
        await listVideos(ctx);
        return;
      case "list_channels":
        await listChannels(ctx);
        return;
      case "clarify":
        await reply(ctx, intent.question);
        return;
    }
  } catch (error) {
    await reply(ctx, `Failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function classifyIntent(
  ctx: BotContext,
  text: string,
  replyText?: string,
): Promise<Intent> {
  const fallback = ruleIntent(ctx, text, replyText);
  if (!deepseekApiKey) return fallback;

  try {
    const memory = getMemory(ctx);
    const raw = await callDeepSeek([
      {
        role: "system",
        content: [
          "Classify a Telegram message for a Tubeo storage bot. Return JSON only.",
          "Allowed types: save_video, save_channel, update_video_note, list_videos, list_channels, clarify.",
          "All storage is Tubeo: save_video writes Tubeo watch-later videos; save_channel writes Tubeo YouTube channels.",
          "Bare link with no instruction must be clarify.",
          "If user replies to a message, use the replied message as context. A reply with note text updates/saves the replied link.",
          "If user says youtube video/watch later/video for a previous link, use save_video.",
          "If user says channel/creator for a YouTube link, use save_channel.",
          "Extract note from phrases like 'note, funny accent' or 'with note: ...'.",
          'Examples: {"type":"save_video","url":"https://...","note":"funny"}',
          'Examples: {"type":"update_video_note","url":"https://...","note":"new note","mode":"replace"}',
          'Examples: {"type":"clarify","question":"Save this as Watch Later video or YouTube channel?"}',
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          message: text,
          repliedMessage: replyText || null,
          recentUserTurns: memory.userTurns.slice(-8),
          recentBotTurns: memory.botTurns.slice(-4),
          lastUrl: memory.lastUrl || null,
          lastSavedVideoUrl: memory.lastSavedVideoUrl || null,
        }),
      },
    ]);
    return normalizeIntent(JSON.parse(jsonOnly(raw)), fallback, ctx, text, replyText);
  } catch (error) {
    console.error("intent classify failed", error);
    return fallback;
  }
}

function ruleIntent(ctx: BotContext, text: string, replyText?: string): Intent {
  const lower = text.toLowerCase();
  const ownUrl = extractFirstUrl(text);
  const contextUrl = resolveContextUrl(ctx, text, replyText);
  const hasReplyUrl = Boolean(replyText && extractFirstUrl(replyText));
  const wantsList = /\b(list|show|what|which|get|display)\b/.test(lower);
  const wantsSave = /\b(save|add|store|keep|remember|bookmark|yes)\b/.test(lower);
  const saysChannel = /\b(channel|creator)\b/.test(lower);
  const saysVideo = /\b(video|watch\s*later|wl|tubeo|youtube video|yt video)\b/.test(lower);
  const note = extractNote(text);

  if (wantsList && /\b(channel|channels)\b/.test(lower)) return { type: "list_channels" };
  if (wantsList && /\b(video|videos|watch|links|saved)\b/.test(lower)) return { type: "list_videos" };
  if (contextUrl && saysChannel && isYouTubeUrl(contextUrl)) {
    return { type: "save_channel", url: contextUrl };
  }
  if (contextUrl && (saysVideo || wantsSave) && isLinkLike(contextUrl)) {
    return { type: "save_video", url: contextUrl, note };
  }
  if (contextUrl && hasReplyUrl && note) {
    return { type: "update_video_note", url: contextUrl, note, mode: "replace" };
  }
  if (ownUrl) {
    return {
      type: "clarify",
      question: `Save this as Watch Later video/link or YouTube channel?\n${ownUrl}`,
    };
  }
  return {
    type: "clarify",
    question: "Send a link and tell me: save as Watch Later video/link, or save YouTube channel?",
  };
}

function normalizeIntent(
  value: unknown,
  fallback: Intent,
  ctx: BotContext,
  text: string,
  replyText?: string,
): Intent {
  if (!value || typeof value !== "object") return fallback;
  const obj = value as Record<string, unknown>;
  const type = String(obj.type || "");
  const url =
    stringValue(obj.url) ||
    stringValue(obj.link) ||
    resolveContextUrl(ctx, text, replyText);
  const note = stringValue(obj.note) || extractNote(text);
  const mode = obj.mode === "append" ? "append" : "replace";

  if (type === "save_video") {
    return url ? { type, url, note } : { type: "clarify", question: "Which link should I save to Watch Later?" };
  }
  if (type === "save_channel") {
    return url ? { type, url, space: stringValue(obj.space) } : { type: "clarify", question: "Which YouTube link should I use for the channel?" };
  }
  if (type === "update_video_note") {
    return url && note
      ? { type, url, note, mode }
      : { type: "clarify", question: "Which saved link should I update, and what note should I use?" };
  }
  if (type === "list_videos") return { type };
  if (type === "list_channels") return { type };
  if (type === "clarify") {
    return {
      type,
      question: stringValue(obj.question) || fallbackQuestionFor(text, url),
    };
  }
  return fallback;
}

async function saveVideoFromIntent(
  ctx: BotContext,
  originalText: string,
  replyText: string | undefined,
  intent: Extract<Intent, { type: "save_video" }>,
): Promise<void> {
  const url = intent.url || resolveContextUrl(ctx, originalText, replyText);
  if (!url) {
    await reply(ctx, "Which link should I save?");
    return;
  }
  const saved = await upsertSavedVideo(url, intent.note || "");
  rememberSavedVideo(ctx, saved.url);
  await reply(ctx, `${saved.existed ? "Updated" : "Saved"} Watch Later.\n${saved.url}`);
}

async function updateVideoNoteFromIntent(
  ctx: BotContext,
  originalText: string,
  replyText: string | undefined,
  intent: Extract<Intent, { type: "update_video_note" }>,
): Promise<void> {
  const url = intent.url || resolveContextUrl(ctx, originalText, replyText);
  const note = intent.note?.trim();
  if (!url || !note) {
    await reply(ctx, "Reply to a saved/link message with the note you want to set.");
    return;
  }
  const saved = await upsertSavedVideo(url, note, intent.mode || "replace");
  rememberSavedVideo(ctx, saved.url);
  await reply(ctx, `${saved.existed ? "Updated note" : "Saved with note"}.\n${saved.url}`);
}

async function saveChannelFromIntent(
  ctx: BotContext,
  originalText: string,
  replyText: string | undefined,
  intent: Extract<Intent, { type: "save_channel" }>,
): Promise<void> {
  const url = intent.url || resolveContextUrl(ctx, originalText, replyText);
  if (!url) {
    await reply(ctx, "Which YouTube link should I use for the channel?");
    return;
  }
  const channel = await resolveYouTubeChannel(url);
  const existed = await upsertChannel(channel.id, intent.space || DEFAULT_SPACE);
  rememberChannel(ctx, url);
  await reply(ctx, `${existed ? "Channel already saved" : "Saved YouTube channel"}: ${channel.title || channel.id}`);
}

async function listVideos(ctx: BotContext): Promise<void> {
  const videos = await readSavedVideos();
  if (videos.length === 0) {
    await reply(ctx, "No Watch Later videos saved yet.");
    return;
  }
  const lines = videos.slice(0, 10).map((video, index) => {
    const note = video.note ? `\n   note: ${truncate(video.note, 120)}` : "";
    return `${index + 1}. ${video.url}${note}`;
  });
  await reply(ctx, `Watch Later videos:\n${lines.join("\n")}`);
}

async function listChannels(ctx: BotContext): Promise<void> {
  const state = await readTubeoState();
  const channels = state.channels || [];
  if (channels.length === 0) {
    await reply(ctx, "No YouTube channels saved yet.");
    return;
  }
  await reply(ctx, `YouTube channels:\n${channels.slice(0, 20).map((c, i) => `${i + 1}. ${c.id} (${c.space})`).join("\n")}`);
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
  mode: "replace" | "append" = "replace",
): Promise<{ url: string; existed: boolean }> {
  const resolved = resolveSavedVideoFromUrl(rawUrl);
  if (!resolved) throw new Error("Not a valid link.");
  const current = await readSavedVideos();
  const existing = current.find((video) => video.id === resolved.id);
  const cleanNote = note.trim();
  const nextNote = existing
    ? cleanNote
      ? mode === "append" && existing.note
        ? `${existing.note}\n${cleanNote}`
        : cleanNote
      : existing.note
    : cleanNote;
  const saved: SavedVideo = {
    id: resolved.id,
    url: resolved.url,
    note: nextNote,
    category: existing?.category || DEFAULT_CATEGORY,
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  await writeSavedVideos([saved, ...current.filter((video) => video.id !== resolved.id)]);
  return { url: saved.url, existed: Boolean(existing) };
}

async function readTubeoState(): Promise<TubeoState> {
  const qs = new URLSearchParams({
    owner_key: `eq.${ownerKey()}`,
    select: "state",
    limit: "1",
  });
  const res = await tubeoFetch(`${tableUrl(tubeoConfig.syncTable)}?${qs}`);
  if (!res.ok) throw new Error(await errorText(res, "sync-state read failed"));
  const rows = (await res.json()) as Array<{ state?: TubeoState }>;
  return normalizeTubeoState(rows[0]?.state || {});
}

async function writeTubeoState(state: TubeoState): Promise<void> {
  const now = new Date().toISOString();
  const row: SyncRow = {
    owner_key: ownerKey(),
    user_email: tubeoConfig.ownerEmail,
    user_name: tubeoConfig.ownerName,
    state: { ...normalizeTubeoState(state), updatedAt: now },
    state_updated_at: now,
  };
  const qs = new URLSearchParams({ on_conflict: "owner_key" });
  const res = await tubeoFetch(`${tableUrl(tubeoConfig.syncTable)}?${qs}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(await errorText(res, "sync-state write failed"));
}

async function upsertChannel(channelId: string, space: string): Promise<boolean> {
  const state = await readTubeoState();
  const channels = state.channels || [];
  const cleanSpace = normalizeSpace(space);
  const existed = channels.some((channel) => channel.id === channelId);
  const nextChannels = existed
    ? channels.map((channel) =>
        channel.id === channelId ? { ...channel, space: channel.space || cleanSpace } : channel,
      )
    : [{ id: channelId, space: cleanSpace }, ...channels];
  const spaces = new Set([...(state.spaces || [DEFAULT_SPACE]), cleanSpace]);
  await writeTubeoState({
    ...state,
    channels: nextChannels,
    spaces: [...spaces],
  });
  return existed;
}

function normalizeTubeoState(state: TubeoState): TubeoState {
  return {
    channels: Array.isArray(state.channels) ? state.channels : [],
    spaces: Array.isArray(state.spaces) && state.spaces.length > 0 ? state.spaces : [DEFAULT_SPACE],
    view: state.view || defaultView(),
    viewUpdatedAt: typeof state.viewUpdatedAt === "string" ? state.viewUpdatedAt : new Date(0).toISOString(),
    updatesChannelIds: Array.isArray(state.updatesChannelIds) ? state.updatesChannelIds : [],
    vocabs: Array.isArray(state.vocabs) ? state.vocabs : [],
    ignoredChannels: Array.isArray(state.ignoredChannels) ? state.ignoredChannels : [],
    discoverSearches: Array.isArray(state.discoverSearches) ? state.discoverSearches : [],
    ...state,
  };
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

async function resolveYouTubeChannel(raw: string): Promise<{ id: string; title?: string }> {
  const direct = parseYouTubeChannelId(raw);
  if (direct) return { id: direct };

  if (!youtubeApiKey) {
    throw new Error("Set YOUTUBE_API_KEY to resolve channels from video links or handles.");
  }

  const videoId = parseYouTubeVideoId(raw);
  if (videoId) {
    const data = await youtubeApi("videos", { part: "snippet", id: videoId, maxResults: "1" });
    const snippet = data.items?.[0]?.snippet;
    const id = snippet?.channelId?.trim();
    if (!id) throw new Error("Could not resolve channel from this video.");
    return { id, title: snippet?.channelTitle };
  }

  const handle = parseYouTubeHandle(raw);
  if (handle) {
    const data = await youtubeApi("search", {
      part: "snippet",
      type: "channel",
      q: handle,
      maxResults: "1",
    });
    const snippet = data.items?.[0]?.snippet;
    const id = snippet?.channelId?.trim();
    if (!id) throw new Error(`Could not resolve channel for ${handle}.`);
    return { id, title: snippet?.title };
  }

  throw new Error("Send a YouTube channel URL, handle, or video URL.");
}

async function youtubeApi(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, key: youtubeApiKey || "" });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  if (!res.ok) throw new Error(`YouTube API failed: ${res.status}`);
  return res.json();
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

function parseYouTubeChannelId(raw: string): string | null {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]?.startsWith("UC")) return parts[1];
    if (/^UC[\w-]{22}$/.test(raw.trim())) return raw.trim();
    return null;
  } catch {
    return /^UC[\w-]{22}$/.test(raw.trim()) ? raw.trim() : null;
  }
}

function parseYouTubeHandle(raw: string): string | null {
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const part = url.pathname.split("/").filter(Boolean).find((item) => item.startsWith("@"));
    return part?.replace(/^@/, "") || null;
  } catch {
    const trimmed = raw.trim().replace(/^@/, "");
    return trimmed && !trimmed.includes(" ") ? trimmed : null;
  }
}

function resolveContextUrl(ctx: BotContext, text: string, replyText?: string): string | undefined {
  return (
    extractFirstUrl(text) ||
    extractFirstUrl(replyText) ||
    getMemory(ctx).lastUrl ||
    getMemory(ctx).lastSavedVideoUrl
  );
}

function rememberUserTurn(ctx: BotContext, text: string): void {
  const memory = getMemory(ctx);
  pushBounded(memory.userTurns, text, 20);
  const url = extractFirstUrl(text);
  if (url) memory.lastUrl = url;
}

function rememberSavedVideo(ctx: BotContext, url: string): void {
  const memory = getMemory(ctx);
  memory.lastUrl = url;
  memory.lastSavedVideoUrl = url;
}

function rememberChannel(ctx: BotContext, url: string): void {
  const memory = getMemory(ctx);
  memory.lastUrl = url;
  memory.lastChannelUrl = url;
}

async function reply(ctx: BotContext, text: string): Promise<void> {
  await ctx.reply(text);
  pushBounded(getMemory(ctx).botTurns, text, 12);
}

function getMemory(ctx: BotContext): ChatMemory {
  const key = `${ctx.chat?.id || "nochat"}:${ctx.from?.id || "nouser"}`;
  let memory = memoryByChat.get(key);
  if (!memory) {
    memory = { userTurns: [], botTurns: [] };
    memoryByChat.set(key, memory);
  }
  return memory;
}

function pushBounded<T>(items: T[], item: T, max: number): void {
  items.push(item);
  while (items.length > max) items.shift();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function getReplyText(ctx: BotContext): string | undefined {
  const replyMessage = ctx.message?.reply_to_message;
  if (!replyMessage || !("text" in replyMessage) || typeof replyMessage.text !== "string") {
    return undefined;
  }
  return replyMessage.text.trim();
}

function extractFirstUrl(text?: string): string | undefined {
  return text?.match(URL_RE)?.[0]?.replace(/[),.;!?]+$/g, "");
}

function extractNote(text: string): string | undefined {
  const match = text.match(/\b(?:note|with note|caption)\b[:,\s-]*(.+)$/is);
  if (match?.[1]?.trim()) return match[1].trim();
  return undefined;
}

function isLinkLike(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isYouTubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname.toLowerCase();
    return host.includes("youtube.com") || host.includes("youtu.be");
  } catch {
    return false;
  }
}

function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "igshid", "si"]) {
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

function defaultView(): unknown {
  return {
    home: { range: "7d", media: "all", duration: "all" },
    channels: { range: "7d", media: "all", duration: "all", space: "all" },
    updates: { range: "7d", media: "all", duration: "all" },
  };
}

function normalizeSpace(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean || DEFAULT_SPACE;
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

async function callDeepSeek(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  if (!deepseekApiKey) return "";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages,
      temperature: 0.2,
      max_tokens: 500,
    }),
  });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function jsonOnly(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fallbackQuestionFor(_text: string, url?: string): string {
  return url
    ? `Save this as Watch Later video/link or YouTube channel?\n${url}`
    : "Send a link and tell me whether to save it as Watch Later video/link or YouTube channel.";
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
