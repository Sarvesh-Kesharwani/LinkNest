import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { Bot, Context, webhookCallback } from "grammy";

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
const chatthoughtsSchema = process.env.CHATTHOUGHTS_SCHEMA;
const chatthoughtsNeedColumn =
  process.env.CHATTHOUGHTS_NEED_COLUMN || "when_needed";
const chatthoughtsTitleColumn =
  process.env.CHATTHOUGHTS_TITLE_COLUMN || "mantra";

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

type BotContext = Context;

type BotIntent =
  | { type: "save_link"; link?: string; note?: string }
  | { type: "save_thought"; text?: string }
  | { type: "save_youtube_channel"; link?: string }
  | { type: "list_saved_links"; query?: string }
  | { type: "list_saved_thoughts"; query?: string }
  | { type: "clarify"; question: string };

const bot = new Bot<BotContext>(telegramToken);

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

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  await handleTextMessage(ctx, text);
});

async function handleTextMessage(ctx: BotContext, text: string): Promise<void> {
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, text, "no sender id.");
    return;
  }

  const intent = await classifyIntent(ctx, text);
  switch (intent.type) {
    case "save_link":
      await handleSaveLinkIntent(ctx, text, intent);
      return;
    case "save_thought":
      await handleSaveThoughtIntent(ctx, text, intent);
      return;
    case "save_youtube_channel":
      await handleSaveYouTubeChannelIntent(ctx, text, intent);
      return;
    case "list_saved_links":
      await replyWithLegacyArchive(ctx, intent.query || "");
      return;
    case "list_saved_thoughts":
      await replyWithSavedThoughts(ctx, text, intent.query || "");
      return;
    case "clarify":
      await replyAndRemember(ctx, text, intent.question);
      return;
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

async function classifyIntent(ctx: BotContext, text: string): Promise<BotIntent> {
  const fallback = ruleClassifyIntent(text);
  if (!deepseekApiKey) return fallback;

  const conversation = await readConversation(ctx).catch(() => null);
  const recent = (conversation?.recent_messages || [])
    .slice(-8)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");

  try {
    const raw = await callDeepSeek([
      {
        role: "system",
        content: [
          "Classify one Telegram bot user message into JSON only.",
          "Allowed types: save_link, save_thought, save_youtube_channel, list_saved_links, list_saved_thoughts, clarify.",
          "Never infer save intent from a bare link. Bare link => clarify.",
          "Save link only when user explicitly asks to save/store/add/bookmark a link.",
          "Save thought only when user explicitly asks to save a thought/note/idea.",
          "Save YouTube channel only when user explicitly asks to save/add the channel from a YouTube link.",
          "List links/thoughts only when user asks to show/list/get saved items.",
          'Return compact JSON like {"type":"save_link","link":"https://...","note":"optional"} or {"type":"clarify","question":"short question"}',
        ].join(" "),
      },
      {
        role: "user",
        content: `Conversation summary:\n${conversation?.summary || "(none)"}\n\nRecent turns:\n${recent || "(none)"}\n\nMessage:\n${text}`,
      },
    ]);
    return normalizeIntent(JSON.parse(jsonOnly(raw)), fallback, text);
  } catch (error) {
    console.error("intent classification failed", error);
    return fallback;
  }
}

function ruleClassifyIntent(text: string): BotIntent {
  const clean = text.trim();
  const url = extractFirstUrl(clean);
  const lower = clean.toLowerCase();
  const asksList = /\b(list|show|get|what|which|display)\b/.test(lower);
  const asksSave = /\b(save|store|add|bookmark|remember|keep)\b/.test(lower);
  const saysThought = /\b(thought|thoughts|note|notes|idea|ideas)\b/.test(lower);
  const saysLink = /\b(link|links|url|urls|watch later|archive)\b/.test(lower);
  const saysChannel = /\b(channel|channels|creator|youtube channel)\b/.test(lower);

  if (asksList && saysThought) return { type: "list_saved_thoughts" };
  if (asksList && (saysLink || /\bsaved\b/.test(lower))) return { type: "list_saved_links" };
  if (url && asksSave && saysChannel && isYouTubeUrl(url)) {
    return { type: "save_youtube_channel", link: url };
  }
  if (url && asksSave) {
    return { type: "save_link", link: url, note: extractSaveNote(clean, url) };
  }
  if (!url && asksSave && saysThought) {
    return { type: "save_thought", text: stripSaveWords(clean) };
  }
  if (url) {
    return {
      type: "clarify",
      question: "What should I do with this link: save it, save its YouTube channel, or ignore it?",
    };
  }
  return {
    type: "clarify",
    question: "What should I do: save a link, save a thought, list links, or list thoughts?",
  };
}

function normalizeIntent(value: unknown, fallback: BotIntent, originalText: string): BotIntent {
  if (!value || typeof value !== "object") return fallback;
  const obj = value as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  const link =
    typeof obj.link === "string" && obj.link.trim()
      ? obj.link.trim()
      : extractFirstUrl(originalText);
  const note = typeof obj.note === "string" ? obj.note.trim() : undefined;
  const query = typeof obj.query === "string" ? obj.query.trim() : undefined;
  const text = typeof obj.text === "string" ? obj.text.trim() : undefined;

  if (type === "save_link") {
    if (!link) return { type: "clarify", question: "Which link should I save?" };
    return { type, link, note };
  }
  if (type === "save_thought") {
    const thought = text || stripSaveWords(originalText);
    if (!thought) return { type: "clarify", question: "What thought should I save?" };
    return { type, text: thought };
  }
  if (type === "save_youtube_channel") {
    if (!link) return { type: "clarify", question: "Send the YouTube video link whose channel I should save." };
    return { type, link };
  }
  if (type === "list_saved_links") return { type, query };
  if (type === "list_saved_thoughts") return { type, query };
  if (type === "clarify") {
    const question = typeof obj.question === "string" && obj.question.trim()
      ? obj.question.trim()
      : "What should I do with this?";
    return { type, question };
  }
  return fallback;
}

async function handleSaveLinkIntent(
  ctx: BotContext,
  text: string,
  intent: Extract<BotIntent, { type: "save_link" }>,
): Promise<void> {
  const rowId = await insertSavedLink(ctx, intent.link || text, intent.note);
  if (rowId == null) return;
  const reply = intent.note ? "Saved link with note." : "Saved link.";
  await replyAndRemember(ctx, text, reply);
}

async function handleSaveThoughtIntent(
  ctx: BotContext,
  text: string,
  intent: Extract<BotIntent, { type: "save_thought" }>,
): Promise<void> {
  if (!chatthoughts) {
    await replyAndRemember(ctx, text, "Thoughts DB is not configured.");
    return;
  }
  const thought = (intent.text || stripSaveWords(text)).trim();
  if (!thought) {
    await replyAndRemember(ctx, text, "What thought should I save?");
    return;
  }
  const result = await insertChatThought(thought);
  if (!result.ok) {
    console.error("thought save failed", result.error);
    await replyAndRemember(ctx, text, `fail: ${result.error}`);
    return;
  }
  await replyAndRemember(ctx, text, "Saved thought.");
}

async function handleSaveYouTubeChannelIntent(
  ctx: BotContext,
  text: string,
  intent: Extract<BotIntent, { type: "save_youtube_channel" }>,
): Promise<void> {
  const sender = ctx.from;
  const link = intent.link || extractFirstUrl(text);
  if (!sender || !link) {
    await replyAndRemember(ctx, text, "Send the YouTube video link whose channel I should save.");
    return;
  }
  if (!isYouTubeUrl(link)) {
    await replyAndRemember(ctx, text, "That is not a YouTube link. Send a YouTube video link.");
    return;
  }
  if (!isTubeoConfigured()) {
    await replyAndRemember(ctx, text, "Tubeo ingest is not configured, so I cannot save channels yet.");
    return;
  }
  if (!isTubeoUserAllowed(sender.id)) {
    await replyAndRemember(ctx, text, "This Telegram user is not allowed to save Tubeo channels.");
    return;
  }
  const result = await callTubeoIngest({
    text: `save channel ${link}`,
    lastUrl: link,
    telegramUserId: sender.id,
    telegramMessageId: ctx.msg?.message_id ?? 0,
  });
  if (!result.ok) {
    await replyAndRemember(ctx, text, `Channel save failed: ${result.error || "unknown error"}`);
    return;
  }
  await replyAndRemember(ctx, text, `Saved channel. ${result.summary || ""}`.trim());
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
  note?: string,
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
  if (existing.data) {
    const id = (existing.data as { id: string }).id;
    if (note?.trim()) {
      const { error } = await linknest
        .from(legacyLinksTable)
        .update({ note: note.trim().slice(0, 5000), note_status: "added" })
        .eq("id", id);
      if (error) {
        await replyAndRemember(ctx, text, `fail: ${error.message}`);
        return null;
      }
    }
    return id;
  }

  const { data, error } = await linknest
    .from(legacyLinksTable)
    .insert({
      sender_id: sender.id,
      sender_username: sender.username ?? null,
      chat_id: chatId ?? sender.id,
      platform: detectPlatform(canonicalUrl),
      original_url: url,
      canonical_url: canonicalUrl,
      note: note?.trim() ? note.trim().slice(0, 5000) : null,
      note_status: note?.trim() ? "added" : "pending",
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

interface ChatThoughtRow {
  id: string;
  [key: string]: unknown;
  created_at?: string | null;
}

interface ChatThoughtsConfig {
  schema?: string;
  table: string;
  needColumn: string;
  titleColumn: string;
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

async function replyWithSavedThoughts(
  ctx: BotContext,
  text: string,
  query: string,
): Promise<void> {
  if (!chatthoughts) {
    await replyAndRemember(ctx, text, "Thoughts DB is not configured.");
    return;
  }

  const result = await listChatThoughts();
  if (!result.ok) {
    console.error("thought list failed", result.error);
    await replyAndRemember(ctx, text, `thought list failed: ${result.error}`);
    return;
  }

  const rows = result.rows.filter((row) => {
    if (!query.trim()) return true;
    return thoughtTitle(row, result.config).toLowerCase().includes(query.toLowerCase());
  });
  if (rows.length === 0) {
    await replyAndRemember(ctx, text, query ? `No thoughts match: ${query}` : "No saved thoughts found.");
    return;
  }

  const body = rows
    .slice(0, 10)
    .map((row, index) => `${index + 1}. ${truncate(thoughtTitle(row, result.config), 120)}`)
    .join("\n");
  await replyAndRemember(ctx, text, `Saved thoughts:\n${body}`);
}

function chatThoughtConfigs(): ChatThoughtsConfig[] {
  const configs: ChatThoughtsConfig[] = [
    {
      schema: chatthoughtsSchema,
      table: chatthoughtsTable,
      needColumn: chatthoughtsNeedColumn,
      titleColumn: chatthoughtsTitleColumn,
    },
  ];
  if (
    chatthoughtsSchema !== "chatthoughts" ||
    chatthoughtsTable !== "thoughts" ||
    chatthoughtsNeedColumn !== "need_when" ||
    chatthoughtsTitleColumn !== "mantra"
  ) {
    configs.push({
      schema: "chatthoughts",
      table: "thoughts",
      needColumn: "need_when",
      titleColumn: "mantra",
    });
  }
  return configs;
}

function chatThoughtsTable(config: ChatThoughtsConfig) {
  if (!chatthoughts) throw new Error("Thoughts DB is not configured.");
  return config.schema
    ? chatthoughts.schema(config.schema).from(config.table)
    : chatthoughts.from(config.table);
}

async function insertChatThought(
  thought: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const config of chatThoughtConfigs()) {
    const row = {
      [config.needColumn]: "Saved from Telegram",
      [config.titleColumn]: thought.slice(0, 1000),
    };
    const { error } = await chatThoughtsTable(config).insert(row);
    if (!error) return { ok: true };
    console.error("thought insert attempt failed", config, error.message);
  }
  return { ok: false, error: "could not insert into configured ChatThoughts table" };
}

async function listChatThoughts(): Promise<
  | { ok: true; rows: ChatThoughtRow[]; config: ChatThoughtsConfig }
  | { ok: false; error: string }
> {
  for (const config of chatThoughtConfigs()) {
    const columns = `id, ${config.needColumn}, ${config.titleColumn}, created_at`;
    const { data, error } = await chatThoughtsTable(config)
      .select(columns)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!error) return { ok: true, rows: ((data || []) as unknown) as ChatThoughtRow[], config };
    console.error("thought list attempt failed", config, error.message);
  }
  return { ok: false, error: "could not read configured ChatThoughts table" };
}

function thoughtTitle(row: ChatThoughtRow, config: ChatThoughtsConfig): string {
  const value = row[config.titleColumn];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return String(parsed.title || parsed.short || parsed._raw || value).trim();
    } catch {
      return value.trim();
    }
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return String(
      obj.title ||
        obj.short ||
        obj._raw ||
        row[config.needColumn] ||
        "Untitled thought",
    ).trim();
  }
  return String(row[config.needColumn] || "Untitled thought");
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
  const rememberedRequest = query ? `list saved links: ${query}` : "list saved links";
  const sender = ctx.from;
  if (!sender) {
    await replyAndRemember(ctx, rememberedRequest, "no sender id.");
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
    await replyAndRemember(ctx, rememberedRequest, `saved links lookup failed: ${error.message}`);
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
      rememberedRequest,
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
      ? "\n\nAsk with a narrower search, like: list saved links about youtube ai"
      : "";
  await replyAndRemember(ctx, rememberedRequest, `${header}\n\n${body}${suffix}`);
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

function isYouTubeUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname.includes("youtube.com") || hostname.includes("youtu.be");
  } catch {
    return false;
  }
}

function extractSaveNote(text: string, url: string): string | undefined {
  const withoutUrl = text.replace(url, " ").trim();
  const noteMatch = withoutUrl.match(/\b(?:note|with note|as)\b[:\s-]*(.+)$/i);
  const note = noteMatch?.[1]?.trim();
  if (note) return note;
  const cleaned = stripSaveWords(withoutUrl);
  return cleaned && cleaned !== withoutUrl ? cleaned : undefined;
}

function stripSaveWords(text: string): string {
  return text
    .replace(/^\/\w+\s*/, "")
    .replace(/\b(please|pls)\b/gi, "")
    .replace(/\b(save|store|add|bookmark|remember|keep)\b/gi, "")
    .replace(/\b(this|as|a|an|the|thought|note|idea|link|url)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function jsonOnly(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
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
  await bot.api.setMyCommands([]);
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
