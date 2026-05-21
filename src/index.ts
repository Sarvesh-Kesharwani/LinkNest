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
const conversationTable =
  process.env.LINKNEST_CONVERSATION_TABLE || "linknest_conversations";
const legacyArchiveFetchLimit = clampNumber(
  Number(process.env.LEGACY_ARCHIVE_FETCH_LIMIT || 200),
  25,
  1000,
);
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";

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
const SAVED_QUESTION_RE =
  /\b(what|which|show|tell)\b[\s\S]{0,40}\b(save|saved|store|stored)\b|\blast\s+(saved|save)\b/i;
const CHAT_RE = /\b(hi|hello|hey|thanks|thank you|who are you|what can you do|help)\b/i;

bot.command("start", async (ctx) => {
  ctx.session.state = { kind: "idle" };
  await replyAndRemember(
    ctx,
    "/start",
    "send link to save it. reply with note. ask \"what did you save?\" anytime.",
  );
});

bot.command("reset", async (ctx) => {
  ctx.session.state = { kind: "idle" };
  await replyAndRemember(ctx, "/reset", "reset.");
});

bot.command("skip", async (ctx) => {
  const s = ctx.session.state;
  if (s.kind === "awaiting_note") {
    ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined: s.original };
    await replyAndRemember(ctx, "/skip", "ok.");
  } else {
    await replyAndRemember(ctx, "/skip", "nothing pending.");
  }
});

bot.command(["archive", "legacy"], async (ctx) => {
  await replyWithLegacyArchive(ctx, ctx.match.trim());
});

bot.command("linknest", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) {
    await replyAndRemember(ctx, "/linknest", "send /linknest <text or url>.");
    return;
  }
  await handleTextMessage(ctx, text);
});

bot.command("thought", async (ctx) => {
  const text = ctx.match.trim();
  if (!text) {
    await replyAndRemember(ctx, "/thought", "send /thought <text>.");
    return;
  }
  if (!chatthoughts) {
    await replyAndRemember(ctx, text, "thoughts not configured.");
    return;
  }
  const mantra = JSON.stringify({ short: text, _raw: text });
  const { error } = await chatthoughts
    .from(chatthoughtsTable)
    .insert({ when_needed: null, mantra });
  if (error) {
    console.error("thought save failed", error);
    await replyAndRemember(ctx, text, `fail: ${error.message}`);
    return;
  }
  ctx.session.state = { kind: "idle" };
  await replyAndRemember(ctx, text, "saved thought.");
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    await replyAndRemember(ctx, text, "unknown command. send a link/text, or use /archive, /skip, /reset.");
    return;
  }
  await handleTextMessage(ctx, text);
});

async function handleTextMessage(ctx: BotContext, text: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, text, "no sender id.");
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
      await replyAndRemember(ctx, text, `tubeo: ${result.summary}`);
    } else if (!result.ok && result.error) {
      await replyAndRemember(ctx, text, `tubeo fail: ${result.error}`);
    }

    if (!hasUrl && (replyUrl || TUBEO_INTENT_RE.test(text))) {
      return;
    }
  }

  if (!hasUrl && SAVED_QUESTION_RE.test(text)) {
    await replyWithSaveMemory(ctx, text);
    return;
  }

  if (!hasUrl && s.kind === "idle" && CHAT_RE.test(text)) {
    await replyWithConversation(ctx, text);
    return;
  }

  // Global redirect: user says "thought" -> move most recent linknest row to chatthoughts.
  if (
    THOUGHT_RE.test(text) &&
    (s.kind === "awaiting_note" ||
      s.kind === "last_saved" ||
      s.kind === "confirm_update")
  ) {
    const sourceText =
      s.kind === "awaiting_note" ? s.original : s.kind === "last_saved" ? s.combined : s.combined;
    if (!chatthoughts) {
      await replyAndRemember(ctx, text, "thoughts not configured.");
      return;
    }
    const { error: delErr } = await deleteSavedRow(s.target, s.rowId);
    if (delErr) {
      console.error("delete failed", delErr);
      await replyAndRemember(ctx, text, `fail: ${delErr.message}`);
      return;
    }
    const mantra = JSON.stringify({ short: sourceText, _raw: sourceText });
    const { error: insErr } = await chatthoughts
      .from(chatthoughtsTable)
      .insert({ when_needed: null, mantra });
    if (insErr) {
      console.error("thought save failed", insErr);
      await replyAndRemember(ctx, text, `fail: ${insErr.message}`);
      return;
    }
    ctx.session.state = { kind: "idle" };
    await replyAndRemember(ctx, text, "moved to thought.");
    return;
  }

  switch (s.kind) {
    case "idle": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await replyAndRemember(ctx, text, "saved link. want to add a note?");
      } else {
        const rowId = await insertLinknestNote(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "last_saved", rowId, target: "note", combined: text };
        await replyAndRemember(ctx, text, "saved.");
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
        await replyAndRemember(ctx, text, "ok, saved without note.");
        return;
      }
      const combined = `${s.original}\n\n${text}`;
      const { error } = await updateSavedRow(s.target, s.rowId, combined);
      if (error) {
        console.error("note update failed", error);
        await replyAndRemember(ctx, text, `fail: ${error.message}`);
        return;
      }
      ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined };
      await replyAndRemember(ctx, text, "added that note.");
      return;
    }

    case "last_saved": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await replyAndRemember(ctx, text, "saved link. want to add a note?");
        return;
      }
      ctx.session.state = {
        kind: "confirm_update",
        rowId: s.rowId,
        target: s.target,
        combined: s.combined,
        pendingText: text,
      };
      await replyAndRemember(ctx, text, "add this to the previous saved item? reply yes/no, or say thought.");
      return;
    }

    case "confirm_update": {
      if (hasUrl) {
        const rowId = await insertSavedLink(ctx, text);
        if (rowId == null) return;
        ctx.session.state = { kind: "awaiting_note", rowId, target: "saved_link", original: text };
        await replyAndRemember(ctx, text, "saved link. want to add a note?");
        return;
      }
      if (YES_RE.test(text)) {
        const combined = `${s.combined}\n${s.pendingText}`;
        const { error } = await updateSavedRow(s.target, s.rowId, combined);
        if (error) {
          console.error("note append failed", error);
          await replyAndRemember(ctx, text, `fail: ${error.message}`);
          return;
        }
        ctx.session.state = { kind: "last_saved", rowId: s.rowId, target: s.target, combined };
        await replyAndRemember(ctx, text, "updated previous saved item.");
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
      await replyAndRemember(ctx, text, "saved as a new note.");
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
    await replyAndRemember(ctx, text, `fail: ${error.message}`);
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
    await replyAndRemember(ctx, text, "no url found.");
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
    await replyAndRemember(ctx, text, `fail: ${existing.error.message}`);
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
    await replyAndRemember(ctx, text, `fail: ${error.message}`);
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

interface LinknestNoteRow {
  id: string;
  text: string | null;
  created_at: string | null;
}

interface ConversationTurn {
  role: "user" | "bot";
  text: string;
  at: string;
}

interface ConversationRow {
  summary: string | null;
  recent_messages: ConversationTurn[] | null;
}

async function replyAndRemember(
  ctx: BotContext,
  userText: string,
  botText: string,
): Promise<void> {
  await ctx.reply(botText);
  await rememberTurn(ctx, userText, botText).catch((error) => {
    console.error("conversation memory failed", error);
  });
}

async function rememberTurn(
  ctx: BotContext,
  userText: string,
  botText: string,
): Promise<void> {
  const sender = ctx.from;
  if (!sender) return;
  const chatId = ctx.chat?.id ?? sender.id;
  const now = new Date().toISOString();

  const { data, error } = await linknest
    .from(conversationTable)
    .select("summary, recent_messages")
    .eq("sender_id", sender.id)
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;

  const row = data as ConversationRow | null;
  const previous = Array.isArray(row?.recent_messages) ? row.recent_messages : [];
  const next = [
    ...previous,
    { role: "user" as const, text: userText.slice(0, 2000), at: now },
    { role: "bot" as const, text: botText.slice(0, 2000), at: now },
  ];
  const overflow = next.length > 20 ? next.slice(0, next.length - 16) : [];
  const recent = next.slice(-16);
  const summary =
    overflow.length > 0
      ? await summarizeConversation(row?.summary || "", overflow)
      : row?.summary || "";

  const { error: upsertError } = await linknest
    .from(conversationTable)
    .upsert(
      {
        sender_id: sender.id,
        sender_username: sender.username ?? null,
        chat_id: chatId,
        summary,
        recent_messages: recent,
        updated_at: now,
      },
      { onConflict: "sender_id,chat_id" },
    );
  if (upsertError) throw upsertError;
}

async function summarizeConversation(
  existingSummary: string,
  turns: ConversationTurn[],
): Promise<string> {
  const transcript = turns
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n")
    .slice(0, 12000);
  const fallback = truncate(
    `${existingSummary ? `${existingSummary}\n` : ""}${transcript}`,
    3000,
  );
  if (!deepseekApiKey) return fallback;

  const response = await callDeepSeek([
    {
      role: "system",
      content:
        "Summarize this Telegram bot conversation for future context. Keep durable facts, user preferences, open tasks, last saved items, and unresolved questions. Be concise.",
    },
    {
      role: "user",
      content: `Previous summary:\n${existingSummary || "(none)"}\n\nNew turns:\n${transcript}`,
    },
  ]);
  return truncate(response || fallback, 3000);
}

async function replyWithConversation(ctx: BotContext, text: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, text, "no sender id.");
    return;
  }
  const conversation = await readConversation(ctx);
  const fallback =
    "I can save links, remember notes, and answer what I saved recently. Send a link and I'll store it.";
  if (!deepseekApiKey) {
    await replyAndRemember(ctx, text, fallback);
    return;
  }

  const recent = (conversation?.recent_messages || [])
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  const answer = await callDeepSeek([
    {
      role: "system",
      content:
        "You are LinkNest, a concise human Telegram assistant. Use the summary and recent turns. Do not claim to save something unless the conversation or database says so.",
    },
    {
      role: "user",
      content: `Conversation summary:\n${conversation?.summary || "(none)"}\n\nRecent turns:\n${recent || "(none)"}\n\nUser now says:\n${text}`,
    },
  ]).catch((error) => {
    console.error("conversation AI failed", error);
    return fallback;
  });
  await replyAndRemember(ctx, text, answer || fallback);
}

async function replyWithSaveMemory(ctx: BotContext, text: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, text, "no sender id.");
    return;
  }

  const [linkResult, noteResult] = await Promise.all([
    linknest
      .from(legacyLinksTable)
      .select("id, platform, original_url, canonical_url, note, note_status, created_at")
      .eq("sender_id", sender.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    linknest
      .from(linknestTable)
      .select("id, text, created_at")
      .eq("sender_id", sender.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (linkResult.error) {
    await replyAndRemember(ctx, text, `save lookup failed: ${linkResult.error.message}`);
    return;
  }
  if (noteResult.error) {
    await replyAndRemember(ctx, text, `note lookup failed: ${noteResult.error.message}`);
    return;
  }

  const link = linkResult.data as LegacySavedLink | null;
  const note = noteResult.data as LinknestNoteRow | null;
  const linkTime = link?.created_at ? Date.parse(link.created_at) : 0;
  const noteTime = note?.created_at ? Date.parse(note.created_at) : 0;

  if (!link && !note) {
    await replyAndRemember(ctx, text, "I haven't saved anything for you yet.");
    return;
  }

  if (link && linkTime >= noteTime) {
    const url = link.original_url || link.canonical_url || "(no url)";
    const noteText = link.note?.trim();
    const reply = noteText
      ? `Last saved: ${url}\nNote: ${truncate(noteText, 500)}`
      : `Last saved: ${url}`;
    await replyAndRemember(ctx, text, reply);
    return;
  }

  await replyAndRemember(ctx, text, `Last saved note: ${truncate(note?.text || "", 700)}`);
}

async function readConversation(ctx: BotContext): Promise<ConversationRow | null> {
  const sender = ctx.from;
  if (!sender) return null;
  const chatId = ctx.chat?.id ?? sender.id;
  const { data, error } = await linknest
    .from(conversationTable)
    .select("summary, recent_messages")
    .eq("sender_id", sender.id)
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  return data as ConversationRow | null;
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
      temperature: 0.4,
      max_tokens: 500,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function replyWithLegacyArchive(ctx: BotContext, query: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, `/archive ${query}`.trim(), "no sender id.");
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
    await replyAndRemember(ctx, `/archive ${query}`.trim(), `archive fail: ${error.message}`);
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
    await replyAndRemember(
      ctx,
      `/archive ${query}`.trim(),
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
  await replyAndRemember(ctx, `/archive ${query}`.trim(), `${header}\n\n${body}${suffix}`);
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
