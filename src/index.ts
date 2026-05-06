import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { Bot } from "grammy";

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const supabaseUrl = requiredEnv("SUPABASE_URL");
const supabaseServiceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const tableName = process.env.SUPABASE_TABLE || "saved_links";

const bot = new Bot(telegramToken);
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

type Platform = "instagram" | "youtube" | "unknown";

type LinkInfo = {
  platform: Platform;
  originalUrl: string;
  canonicalUrl: string;
};

bot.command("start", async (ctx) => {
  await ctx.reply("Send Instagram Reel/Post or YouTube/Shorts links. I will save them.");
});

bot.on("message", async (ctx) => {
  const text = ctx.message.text ?? ctx.message.caption ?? "";
  const links = extractLinks(text).map(normalizeLink);

  if (links.length === 0) {
    await ctx.reply("No link found. Send Instagram or YouTube URL.");
    return;
  }

  const sender = ctx.from;
  if (!sender) {
    await ctx.reply("Could not identify sender.");
    return;
  }

  let saved = 0;
  let duplicate = 0;
  let failed = 0;

  for (const link of dedupeLinks(links)) {
    const { error } = await supabase.from(tableName).insert({
      sender_id: sender.id,
      sender_username: sender.username ?? null,
      chat_id: ctx.chat.id,
      platform: link.platform,
      original_url: link.originalUrl,
      canonical_url: link.canonicalUrl,
      telegram_message_id: ctx.message.message_id,
    });

    if (!error) {
      saved += 1;
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

  await ctx.reply(formatResult(saved, duplicate, failed));
});

bot.catch((err) => {
  console.error("bot error", err);
});

await bot.start({
  onStart: (botInfo) => {
    console.log(`Bot running as @${botInfo.username}`);
  },
});

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
      platform: "unknown",
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
