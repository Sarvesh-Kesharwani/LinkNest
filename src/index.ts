import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import express from "express";
import { Bot, webhookCallback } from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseKey =
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const tableName = process.env.SUPABASE_TABLE || "saved_links";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const botMode = process.env.BOT_MODE || (process.env.RENDER ? "webhook" : "polling");
const port = Number(process.env.PORT || 10000);

if (!supabaseKey) {
  throw new Error("Missing required env var: SUPABASE_KEY");
}

const bot = new Bot(telegramToken);
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

type Platform = "instagram" | "youtube" | "webpage" | "unknown";

type LinkInfo = {
  platform: Platform;
  originalUrl: string;
  canonicalUrl: string;
};

type PendingNote = {
  linkIds: string[];
  canonicalUrls: string[];
};

type SavedLinkRow = {
  id: string;
  platform: Platform;
  original_url: string;
  canonical_url: string;
  note: string | null;
  created_at: string;
};

type ScoredSavedLink = SavedLinkRow & {
  matchScore: number;
  matchedFields: string[];
};

const pendingNotes = new Map<number, PendingNote>();

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "LinkLoom ready.",
      "Send any link. I will save it and ask for a note.",
      "Ask later: /ask cooking reels",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "Send links: saves to Supabase.",
      "After save: reply with note, or /skip.",
      "Query: /ask <natural language query>",
      "Shortcut query: ? <query>",
    ].join("\n"),
  );
});

bot.command("skip", async (ctx) => {
  const sender = ctx.from;
  if (!sender) return;

  const pending = pendingNotes.get(sender.id);
  if (!pending) {
    await ctx.reply("No pending note.");
    return;
  }

  await updateNoteStatus(pending.linkIds, "skipped");
  pendingNotes.delete(sender.id);
  await ctx.reply("Note skipped.");
});

bot.command("ask", async (ctx) => {
  const query = ctx.match.trim();
  if (!query) {
    await ctx.reply("Use: /ask <what you want to find>");
    return;
  }

  await answerQuery(ctx.from?.id, query, async (message) => ctx.reply(message));
});

bot.on("message", async (ctx) => {
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  const sender = ctx.from;
  if (!sender) {
    await ctx.reply("Could not identify sender.");
    return;
  }

  if (text.trim().startsWith("?")) {
    await answerQuery(sender.id, text.trim().slice(1).trim(), async (message) =>
      ctx.reply(message),
    );
    return;
  }

  const links = extractLinks(text).map(normalizeLink);

  if (links.length === 0) {
    const pending = pendingNotes.get(sender.id);
    if (pending) {
      await saveNote(pending.linkIds, text.trim());
      pendingNotes.delete(sender.id);
      await ctx.reply("Note saved.");
      return;
    }

    await ctx.reply("No link found. Send any URL, or use /ask <query>.");
    return;
  }

  let saved = 0;
  let duplicate = 0;
  let failed = 0;
  const savedIds: string[] = [];
  const savedUrls: string[] = [];

  for (const link of dedupeLinks(links)) {
    const { data, error } = await supabase
      .from(tableName)
      .insert({
        sender_id: sender.id,
        sender_username: sender.username ?? null,
        chat_id: ctx.chat.id,
        platform: link.platform,
        original_url: link.originalUrl,
        canonical_url: link.canonicalUrl,
        telegram_message_id: ctx.message.message_id,
      })
      .select("id, canonical_url")
      .single();

    if (!error) {
      saved += 1;
      savedIds.push(data.id);
      savedUrls.push(data.canonical_url);
      continue;
    }

    if (error.code === "23505") {
      duplicate += 1;
      continue;
    }

    failed += 1;
    console.error("insert failed", {
      code: error.code,
      message: error.message,
      canonicalUrl: link.canonicalUrl,
    });
  }

  if (savedIds.length > 0) {
    pendingNotes.set(sender.id, {
      linkIds: savedIds,
      canonicalUrls: savedUrls,
    });
  }

  const reply = [formatResult(saved, duplicate, failed)];
  if (savedIds.length > 0) {
    reply.push("Send note for this link, or /skip.");
  }
  await ctx.reply(reply.join("\n"));
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
    res.json({ ok: true, service: "LinkLoom bot" });
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
    {
      command: "start",
      description: "Start LinkLoom",
    },
    {
      command: "help",
      description: "Show help",
    },
    {
      command: "ask",
      description: "Search saved links with a question",
    },
    {
      command: "skip",
      description: "Skip note for pending saved link",
    },
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

function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return matches.map((url) => url.replace(/[),.;!?]+$/g, ""));
}

function normalizeLink(originalUrl: string): LinkInfo {
  try {
    const url = new URL(originalUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "youtu.be" || host.endsWith("youtube.com")) {
      return normalizeYouTube(originalUrl, url);
    }

    if (host.endsWith("instagram.com")) {
      return normalizeInstagram(originalUrl, url);
    }

    return {
      platform: "webpage",
      originalUrl,
      canonicalUrl: stripTracking(url).toString(),
    };
  } catch {
    return {
      platform: "unknown",
      originalUrl,
      canonicalUrl: originalUrl,
    };
  }
}

function normalizeYouTube(originalUrl: string, url: URL): LinkInfo {
  const id = getYouTubeId(url);
  if (!id) {
    return {
      platform: "youtube",
      originalUrl,
      canonicalUrl: stripTracking(url).toString(),
    };
  }

  const isShort = url.pathname.split("/").filter(Boolean)[0] === "shorts";
  return {
    platform: "youtube",
    originalUrl,
    canonicalUrl: isShort
      ? `https://www.youtube.com/shorts/${id}`
      : `https://www.youtube.com/watch?v=${id}`,
  };
}

function getYouTubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be") {
    return parts[0] ?? null;
  }

  if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
    return parts[1] ?? null;
  }

  return url.searchParams.get("v");
}

function normalizeInstagram(originalUrl: string, url: URL): LinkInfo {
  const parts = url.pathname.split("/").filter(Boolean);
  const type = parts[0];
  const code = parts[1];

  if ((type === "reel" || type === "p" || type === "tv") && code) {
    return {
      platform: "instagram",
      originalUrl,
      canonicalUrl: `https://www.instagram.com/${type}/${code}/`,
    };
  }

  return {
    platform: "instagram",
    originalUrl,
    canonicalUrl: stripTracking(url).toString(),
  };
}

function stripTracking(url: URL): URL {
  const cleaned = new URL(url);
  cleaned.hash = "";

  for (const key of [...cleaned.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("utm_") ||
      lower === "fbclid" ||
      lower === "igsh" ||
      lower === "si" ||
      lower === "feature"
    ) {
      cleaned.searchParams.delete(key);
    }
  }

  return cleaned;
}

async function saveNote(linkIds: string[], note: string): Promise<void> {
  const cleanNote = note.slice(0, 2000);
  const { error } = await supabase
    .from(tableName)
    .update({ note: cleanNote, note_status: "added" })
    .in("id", linkIds);

  if (error) {
    throw new Error(`Failed to save note: ${error.message}`);
  }
}

async function updateNoteStatus(
  linkIds: string[],
  noteStatus: "skipped",
): Promise<void> {
  const { error } = await supabase
    .from(tableName)
    .update({ note_status: noteStatus })
    .in("id", linkIds);

  if (error) {
    throw new Error(`Failed to update note status: ${error.message}`);
  }
}

async function answerQuery(
  senderId: number | undefined,
  query: string,
  reply: (message: string) => Promise<unknown>,
): Promise<void> {
  if (!senderId) {
    await reply("Could not identify sender.");
    return;
  }

  if (!query) {
    await reply("Query empty.");
    return;
  }

  if (!deepseekApiKey) {
    await reply("DeepSeek key missing. Set DEEPSEEK_API_KEY in .env.");
    return;
  }

  const { data, error } = await supabase
    .from(tableName)
    .select("id, platform, original_url, canonical_url, note, created_at")
    .eq("sender_id", senderId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    await reply(`Supabase query failed: ${error.message}`);
    return;
  }

  const links = (data ?? []) as SavedLinkRow[];
  if (links.length === 0) {
    await reply("No saved links yet.");
    return;
  }

  const rankedMatches = rankSavedLinks(query, links);
  const candidates =
    rankedMatches.length > 0
      ? rankedMatches.slice(0, 25)
      : links.slice(0, 80).map((link) => ({
          ...link,
          matchScore: 0,
          matchedFields: [],
        }));

  if (!deepseekApiKey) {
    await reply(formatLocalSearchResults(query, rankedMatches.slice(0, 8)));
    return;
  }

  const answer = await queryDeepSeek(query, candidates, {
    totalSaved: links.length,
    directMatches: rankedMatches.length,
  });
  await reply(limitTelegramMessage(answer));
}

async function queryDeepSeek(
  query: string,
  links: ScoredSavedLink[],
  searchStats: { totalSaved: number; directMatches: number },
): Promise<string> {
  const linkContext = links
    .map((link, index) => {
      return [
        `${index + 1}. ${link.canonical_url}`,
        `platform: ${link.platform}`,
        `note: ${link.note || "(none)"}`,
        `match_score: ${link.matchScore}`,
        `matched_fields: ${link.matchedFields.join(", ") || "(semantic candidate)"}`,
        `saved: ${link.created_at}`,
      ].join("\n");
    })
    .join("\n\n");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages: [
        {
          role: "system",
          content:
            [
              "You are LinkLoom, a professional saved-link search assistant.",
              "Search only the provided saved links. Never invent links or notes.",
              "Prefer high match_score results because they matched the user's note or URL directly.",
              "Return a clean Telegram-friendly answer in plain text.",
              "Format exactly:",
              "Search results for: <query>",
              "",
              "1. <short useful label>",
              "Platform: <platform>",
              "Link: <url>",
              "Note: <note or No note saved>",
              "Why it matches: <short reason>",
              "",
              "Return up to 7 results. If no candidate is relevant, say: No saved item matched your query.",
            ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Query: ${query}`,
            `Total saved links checked: ${searchStats.totalSaved}`,
            `Direct note/link matches: ${searchStats.directMatches}`,
            "",
            `Candidate saved links:\n${linkContext}`,
          ].join("\n"),
        },
      ],
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return [
      "DeepSeek search failed.",
      `Error: ${response.status} ${body.slice(0, 240)}`,
      "",
      formatLocalSearchResults(query, links.slice(0, 7)),
    ].join("\n");
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return json.choices?.[0]?.message?.content?.trim() || "No answer from DeepSeek.";
}

function rankSavedLinks(query: string, links: SavedLinkRow[]): ScoredSavedLink[] {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = tokenizeSearchQuery(query);

  return links
    .map((link) => {
      const note = normalizeSearchText(link.note || "");
      const canonicalUrl = normalizeSearchText(link.canonical_url);
      const originalUrl = normalizeSearchText(link.original_url);
      const platform = normalizeSearchText(link.platform);
      let matchScore = 0;
      const matchedFields = new Set<string>();

      for (const [field, value] of [
        ["note", note],
        ["link", canonicalUrl],
        ["original link", originalUrl],
        ["platform", platform],
      ] as const) {
        if (!value) continue;
        if (normalizedQuery && value.includes(normalizedQuery)) {
          matchScore += field === "note" ? 10 : 8;
          matchedFields.add(field);
        }

        for (const token of tokens) {
          if (value.includes(token)) {
            matchScore += field === "note" ? 3 : 2;
            matchedFields.add(field);
          }
        }
      }

      return {
        ...link,
        matchScore,
        matchedFields: [...matchedFields],
      };
    })
    .filter((link) => link.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    });
}

function tokenizeSearchQuery(query: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "for",
    "from",
    "in",
    "me",
    "my",
    "of",
    "on",
    "or",
    "show",
    "the",
    "to",
    "with",
  ]);

  return [...new Set(normalizeSearchText(query).split(" "))]
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

function normalizeSearchText(value: string): string {
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep original text when it is not valid URI-encoded content.
  }

  return value
    .toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatLocalSearchResults(query: string, links: ScoredSavedLink[]): string {
  if (links.length === 0) {
    return [
      `Search results for: ${query}`,
      "",
      "No saved item matched your query in notes or links.",
    ].join("\n");
  }

  const results = links.slice(0, 7).flatMap((link, index) => [
    `${index + 1}. ${getLinkLabel(link)}`,
    `Platform: ${link.platform}`,
    `Link: ${link.canonical_url}`,
    `Note: ${link.note || "No note saved"}`,
    `Why it matches: matched ${link.matchedFields.join(", ") || "saved link"}.`,
    "",
  ]);

  return [`Search results for: ${query}`, "", ...results].join("\n").trim();
}

function getLinkLabel(link: SavedLinkRow): string {
  try {
    const url = new URL(link.canonical_url);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return link.platform;
  }
}

function limitTelegramMessage(message: string): string {
  const maxLength = 3900;
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 40).trim()}\n\nResults trimmed. Refine your query.`;
}

function dedupeLinks(links: LinkInfo[]): LinkInfo[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.canonicalUrl)) {
      return false;
    }
    seen.add(link.canonicalUrl);
    return true;
  });
}

function formatResult(saved: number, duplicate: number, failed: number): string {
  const parts: string[] = [];
  if (saved) parts.push(`${saved} saved`);
  if (duplicate) parts.push(`${duplicate} duplicate`);
  if (failed) parts.push(`${failed} failed`);
  return parts.length ? parts.join(", ") : "Nothing saved.";
}
