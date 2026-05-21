import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import {
  Bot,
  Context,
  session,
  type SessionFlavor,
  webhookCallback,
} from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const linknestUrl = requiredEnv("SUPABASE_URL");
const linknestKey =
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!linknestKey) {
  throw new Error("Missing required env var: SUPABASE_KEY");
}
const linknestTable = process.env.LINKNEST_TABLE || "linknest_notes";
const legacyLinksTable = process.env.LEGACY_LINKS_TABLE || "saved_links";
const legacyArchiveFetchLimit = clampNumber(
  Number(process.env.LEGACY_ARCHIVE_FETCH_LIMIT || 200),
  25,
  1000,
);

const chatthoughtsUrl = process.env.CHATTHOUGHTS_SUPABASE_URL;
const chatthoughtsKey =
  process.env.CHATTHOUGHTS_SUPABASE_KEY ||
  process.env.CHATTHOUGHTS_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.CHATTHOUGHTS_SUPABASE_ANON_KEY;
const chatthoughtsTable =
  process.env.CHATTHOUGHTS_TABLE || "chatthoughts_thoughts";

const tubeoApiUrl = process.env.TUBEO_API_URL?.replace(/\/+$/, "");
const tubeoIngestSecret = process.env.TUBEO_TELEGRAM_INGEST_SECRET;
const allowedTubeoTelegramUsers = new Set(
  (process.env.TUBEO_ALLOWED_TELEGRAM_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

const botMode =
  process.env.BOT_MODE || (process.env.RENDER ? "webhook" : "polling");
const port = Number(process.env.PORT || 10000);

type ChatState =
  | { kind: "idle" }
  | { kind: "awaiting_note"; rowId: string; target: SaveTarget; original: string }
  | { kind: "last_saved"; rowId: string; target: SaveTarget; combined: string }
  | {
      kind: "confirm_update";
      rowId: string;
      target: SaveTarget;
      combined: string;
      pendingText: string;
    };

type SaveTarget = "note" | "saved_link";

interface SessionData {
  state: ChatState;
  lastUrl?: string;
}

type BotContext = Context & SessionFlavor<SessionData>;

const bot = new Bot<BotContext>(telegramToken);

bot.use(
  session<SessionData, BotContext>({
    initial: () => ({ state: { kind: "idle" } }),
  }),
);

const linknest: SupabaseClient = createClient(linknestUrl, linknestKey, {
  auth: { persistSession: false },
});

const chatthoughts: SupabaseClient | null =
  chatthoughtsUrl && chatthoughtsKey
    ? createClient(chatthoughtsUrl, chatthoughtsKey, {
        auth: { persistSession: false },
      })
    : null;

const URL_RE = /https?:\/\/\S+/i;
const YES_RE = /^(y|yes|yeah|sure|ok|okay|update|add)\b/i;
const NO_RE = /^(n|no|nope|skip|new)\b/i;
const THOUGHT_RE = /^(thought|thoughts|t)\b/i;
const TUBEO_INTENT_RE = /\b(tubeo|watch\s*later|watchlater|channel|chanl|chanle|note|update)\b/i;

bot.command("start", async (ctx) => {
  ctx.session.state = { kind: "idle" };
  await ctx.reply(
    "send link or text. i save it. reply with note to add note. say 'thought' to move to thoughts.",
  );
});

bot.command("reset", async (ctx) => {
  ctx.session.state = { kind: "idle" };
  await ctx.reply("reset.");
});

bot.command("skip", async (ctx) => {
  const s = ctx.session.state;
  if (s.kind === "awaiting_note") {
    ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined: s.original };
    await ctx.reply("ok.");
  } else {
    await ctx.reply("nothing pending.");
  }
});

bot.command(["archive", "legacy"], async (ctx) => {
  await replyWithLegacyArchive(ctx, ctx.match.trim());
});

bot.command("linknest", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply("send /linknest <text or url>.");
    return;
  }
  await handleTextMessage(ctx, text);
});

bot.command("thought", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) {
    await ctx.reply("send /thought <text>.");
    return;
  }
  if (!chatthoughts) {
    await ctx.reply("thoughts not configured.");
    return;
  }
  const mantra = JSON.stringify({ short: text, _raw: text });
  const { error } = await chatthoughts
    .from(chatthoughtsTable)
    .insert({ when_needed: null, mantra });
  if (error) {
    console.error("thought save failed", error);
    await ctx.reply(`fail: ${error.message}`);
    return;
  }
  ctx.session.state = { kind: "idle" };
  await ctx.reply("saved thought.");
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    await ctx.reply("unknown command. send a link/text, or use /archive, /skip, /reset.");
    return;
  }
  await handleTextMessage(ctx, text);
});

async function handleTextMessage(ctx: BotContext, text: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await ctx.reply("no sender id.");
    return;
  }

  const s = ctx.session.state;
  const hasUrl = URL_RE.test(text);
  const currentUrl = extractFirstUrl(text);
  const replyText = getReplyText(ctx);
  const replyUrl = replyText ? extractFirstUrl(replyText) : null;
  const lastUrl = currentUrl || replyUrl || ctx.session.lastUrl;
  if (currentUrl) ctx.session.lastUrl = currentUrl;

  const shouldCallTubeo =
    isTubeoConfigured() &&
    isTubeoUserAllowed(sender.id) &&
    (hasUrl || Boolean(replyUrl) || TUBEO_INTENT_RE.test(text));
  if (shouldCallTubeo) {
    const result = await callTubeoIngest({
      text,
      replyText,
      lastUrl,
      telegramUserId: sender.id,
      telegramMessageId: ctx.msg?.message_id ?? 0,
    });
    if (result.ok && result.summary) {
      await ctx.reply(`tubeo: ${result.summary}`);
    } else if (!result.ok && result.error) {
      await ctx.reply(`tubeo fail: ${result.error}`);
    }

    if (!hasUrl && (replyUrl || TUBEO_INTENT_RE.test(text))) {
      return;
    }
  }

  // Global redirect: user says "thought" → move most recent linknest row to chatthoughts.
  if (
    THOUGHT_RE.test(text) &&
    (s.kind === "awaiting_note" ||
      s.kind === "last_saved" ||
      s.kind === "confirm_update")
  ) {
    const sourceText =
      s.kind === "awaiting_note" ? s.original : s.kind === "last_saved" ? s.combined : s.combined;
    if (!chatthoughts) {
      await ctx.reply("thoughts not configured.");
      return;
    }
    const { error: delErr } = await deleteSavedRow(s.target, s.rowId);
    if (delErr) {
      console.error("delete failed", delErr);
      await ctx.reply(`fail: ${delErr.message}`);
      return;
    }
    const mantra = JSON.stringify({ short: sourceText, _raw: sourceText });
    const { error: insErr } = await chatthoughts
      .from(chatthoughtsTable)
      .insert({ when_needed: null, mantra });
    if (insErr) {
      console.error("thought save failed", insErr);
      await ctx.reply(`fail: ${insErr.message}`);
      return;
    }
    ctx.session.state = { kind: "idle" };
    await ctx.reply("→ thought.");
    return;
  }

  switch (s.kind) {
    case "idle": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await ctx.reply("note?");
      } else {
        const rowId = await insertLinknestNote(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "last_saved", rowId, target: "note", combined: text };
        await ctx.reply("saved.");
      }
      return;
    }

    case "awaiting_note": {
      if (NO_RE.test(text)) {
        ctx.session.state = {
          kind: "last_saved",
          rowId: s.rowId,
          target: s.target,
          combined: s.original,
        };
        await ctx.reply("ok.");
        return;
      }
      const combined = `${s.original}\n\n${text}`;
      const { error } = await updateSavedRow(s.target, s.rowId, combined);
      if (error) {
        console.error("note update failed", error);
        await ctx.reply(`fail: ${error.message}`);
        return;
      }
      ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined };
      await ctx.reply("✓");
      return;
    }

    case "last_saved": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await ctx.reply("note?");
        return;
      }
      ctx.session.state = {
        kind: "confirm_update",
        rowId: s.rowId,
        target: s.target,
        combined: s.combined,
        pendingText: text,
      };
      await ctx.reply("update prev note? (y/n/thought)");
      return;
    }

    case "confirm_update": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await ctx.reply("note?");
        return;
      }
      if (YES_RE.test(text)) {
        const combined = `${s.combined}\n${s.pendingText}`;
        const { error } = await updateSavedRow(s.target, s.rowId, combined);
        if (error) {
          console.error("note append failed", error);
          await ctx.reply(`fail: ${error.message}`);
          return;
        }
        ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined };
        await ctx.reply("✓");
        return;
      }
      // default: treat as new entry
      const rowId = await insertLinknestNote(ctx, s.pendingText);
      if (rowId == null) return;
      ctx.session.state = {
        kind: "last_saved",
        rowId,
        target: "note",
        combined: s.pendingText,
      };
      await ctx.reply("saved.");
      return;
    }
  }
}

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

async function insertLinknestNote(
  ctx: BotContext,
  text: string,
): Promise<string | null> {
  const sender = ctx.from!;
  const chatId = ctx.chat?.id;
  const { data, error } = await linknest
    .from(linknestTable)
    .insert({
      sender_id: sender.id,
      sender_username: sender.username ?? null,
      chat_id: chatId,
      text: text.slice(0, 5000),
    })
    .select("id")
    .single();
  if (error) {
    console.error("linknest save failed", error);
    await ctx.reply(`fail: ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

async function insertSavedLink(
  ctx: BotContext,
  text: string,
): Promise<string | null> {
  const sender = ctx.from!;
  const chatId = ctx.chat?.id;
  const url = extractFirstUrl(text);
  if (!url) {
    await ctx.reply("no url found.");
    return null;
  }
  const canonicalUrl = canonicalizeUrl(url);
  const existing = await linknest
    .from(legacyLinksTable)
    .select("id")
    .eq("sender_id", sender.id)
    .eq("canonical_url", canonicalUrl)
    .maybeSingle();
  if (existing.error) {
    console.error("saved link lookup failed", existing.error);
    await ctx.reply(`fail: ${existing.error.message}`);
    return null;
  }
  if (existing.data) return (existing.data as { id: string }).id;

  const { data, error } = await linknest
    .from(legacyLinksTable)
    .insert({
      sender_id: sender.id,
      sender_username: sender.username ?? null,
      chat_id: chatId ?? sender.id,
      platform: detectPlatform(canonicalUrl),
      original_url: url,
      canonical_url: canonicalUrl,
      note: null,
      note_status: "pending",
      telegram_message_id: ctx.msg?.message_id ?? null,
      metadata: { source: "telegram_linknest_bot" },
    })
    .select("id")
    .single();
  if (error) {
    console.error("saved link save failed", error);
    await ctx.reply(`fail: ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

async function updateSavedRow(
  target: SaveTarget,
  rowId: string,
  text: string,
): Promise<{ error: Error | null }> {
  if (target === "saved_link") {
    const note = savedLinkNoteFromText(text);
    const { error } = await linknest
      .from(legacyLinksTable)
      .update({ note: note ? note.slice(0, 5000) : null, note_status: note ? "added" : "skipped" })
      .eq("id", rowId);
    return { error: error as Error | null };
  }

  const { error } = await linknest
    .from(linknestTable)
    .update({ text: text.slice(0, 5000) })
    .eq("id", rowId);
  return { error: error as Error | null };
}

async function deleteSavedRow(
  target: SaveTarget,
  rowId: string,
): Promise<{ error: Error | null }> {
  const table = target === "saved_link" ? legacyLinksTable : linknestTable;
  const { error } = await linknest.from(table).delete().eq("id", rowId);
  return { error: error as Error | null };
}

interface TubeoIngestPayload {
  text: string;
  replyText?: string;
  lastUrl?: string;
  telegramUserId: number;
  telegramMessageId: number;
}

interface TubeoIngestResponse {
  ok?: boolean;
  summary?: string;
  error?: string;
  firstUrl?: string | null;
}

interface LegacySavedLink {
  id: string;
  platform: string | null;
  original_url: string | null;
  canonical_url: string | null;
  note: string | null;
  note_status: string | null;
  created_at: string | null;
}

async function replyWithLegacyArchive(ctx: BotContext, query: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await ctx.reply("no sender id.");
    return;
  }

  const { data, error } = await linknest
    .from(legacyLinksTable)
    .select("id, platform, original_url, canonical_url, note, note_status, created_at")
    .eq("sender_id", sender.id)
    .order("created_at", { ascending: false })
    .limit(legacyArchiveFetchLimit);

  if (error) {
    console.error("legacy archive read failed", error);
    await ctx.reply(`archive fail: ${error.message}`);
    return;
  }

  const rows = (data || []) as LegacySavedLink[];
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const filtered =
    terms.length === 0
      ? rows
      : rows.filter((row) => {
          const haystack = [
            row.platform,
            row.original_url,
            row.canonical_url,
            row.note,
            row.note_status,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });

  if (filtered.length === 0) {
    await ctx.reply(
      query
        ? `no legacy links match: ${query}`
        : "no legacy links found for your Telegram user.",
    );
    return;
  }

  const shown = filtered.slice(0, 8);
  const header = query
    ? `legacy archive: ${query}\nshowing ${shown.length}/${filtered.length}`
    : `legacy archive recent\nshowing ${shown.length}/${filtered.length}`;
  const body = shown.map(formatLegacyLink).join("\n\n");
  const suffix =
    filtered.length > shown.length
      ? "\n\nnarrow search: /archive youtube ai"
      : "";
  await ctx.reply(`${header}\n\n${body}${suffix}`);
}

function formatLegacyLink(row: LegacySavedLink, index: number): string {
  const platform = row.platform || "unknown";
  const created = row.created_at ? row.created_at.slice(0, 10) : "no date";
  const url = row.original_url || row.canonical_url || "(no url)";
  const note = row.note?.trim();
  const noteLine = note ? `\n${truncate(note, 160)}` : "";
  return `${index + 1}. ${platform} | ${created}${noteLine}\n${truncate(url, 180)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isTubeoConfigured(): boolean {
  return Boolean(tubeoApiUrl && tubeoIngestSecret);
}

function isTubeoUserAllowed(userId: number): boolean {
  return allowedTubeoTelegramUsers.size === 0 || allowedTubeoTelegramUsers.has(String(userId));
}

function extractFirstUrl(text: string | undefined): string | undefined {
  const match = text?.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0]?.replace(/[),.;!?]+$/g, "");
}

function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    const removableParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "igshid",
      "si",
    ];
    for (const param of removableParams) url.searchParams.delete(param);

    if (url.hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    url.hostname = url.hostname.replace(/^m\./, "www.");
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

function detectPlatform(raw: string): "instagram" | "youtube" | "webpage" | "unknown" {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname.includes("instagram.com")) return "instagram";
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
    return "webpage";
  } catch {
    return "unknown";
  }
}

function savedLinkNoteFromText(text: string): string {
  return text.replace(URL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

function getReplyText(ctx: BotContext): string | undefined {
  const reply = ctx.message?.reply_to_message;
  if (!reply || !("text" in reply) || typeof reply.text !== "string") {
    return undefined;
  }
  return reply.text.trim() || undefined;
}

async function callTubeoIngest(payload: TubeoIngestPayload): Promise<TubeoIngestResponse> {
  if (!tubeoApiUrl || !tubeoIngestSecret) return { ok: false, error: "tubeo not configured" };

  try {
    const response = await fetch(`${tubeoApiUrl}/api/telegram/ingest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tubeoIngestSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => null)) as TubeoIngestResponse | null;
    if (!response.ok || !data?.ok) {
      return { ok: false, error: data?.error || data?.summary || `Tubeo HTTP ${response.status}` };
    }
    return data;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
  await bot.api.setMyCommands([
    { command: "start", description: "How to use" },
    { command: "linknest", description: "Save a note to LinkNest" },
    { command: "thought", description: "Save a thought to ChatThoughts" },
    { command: "archive", description: "Search legacy saved links" },
    { command: "skip", description: "Skip pending note" },
    { command: "reset", description: "Reset conversation state" },
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
