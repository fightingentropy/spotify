import type { PlayerSong } from "@/types/player";

// Ported from src/lib/podcasts.ts. The web parser uses DOMParser (absent in RN),
// so feed parsing here is regex-based. accentClassName → accent color array.
export type PodcastShow = {
  id: string;
  title: string;
  author: string;
  subtitle: string;
  description: string;
  feedUrl: string;
  websiteUrl: string;
  imageUrl: string;
  accent: [string, string, string];
};

export type PodcastEpisode = PlayerSong & {
  source: "podcast";
  podcastId: string;
  podcastTitle: string;
  description: string;
  publishedAt?: string;
};

export const PODCAST_SHOWS: PodcastShow[] = [
  {
    id: "huberman-lab",
    title: "Huberman Lab",
    author: "Andrew Huberman, Ph.D.",
    subtitle: "Neuroscience and science-based tools",
    description: "Neuroscience, health, and performance conversations with Andrew Huberman and guests.",
    feedUrl: "https://feeds.megaphone.fm/hubermanlab",
    websiteUrl: "https://www.hubermanlab.com/podcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/042e6144-725e-11ec-a75d-c38f702aecad/image/ee4f0b7b466ca35620792970d9bce2d2.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accent: ["#1ed760", "#06b6d4", "#f97316"],
  },
  {
    id: "modern-wisdom",
    title: "Modern Wisdom",
    author: "Chris Williamson",
    subtitle: "Lessons from the greatest thinkers on the planet",
    description: "Life lessons, ideas, and tactics for navigating modern life with Chris Williamson and guests.",
    feedUrl: "https://feeds.megaphone.fm/SIXMSB5088139739",
    websiteUrl: "https://chriswillx.com/podcast/",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/a62f84c0-f8b6-11ed-a4fc-fb9e7841d45b/image/76ed638554a4be965517200d1cd5f30d.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accent: ["#f97316", "#facc15", "#7c3aed"],
  },
  {
    id: "flagrant",
    title: "Flagrant",
    author: "Andrew Schulz",
    subtitle: "Unfiltered comedy and culture",
    description: "Unfiltered comedy, culture, and unruly conversations with Andrew Schulz and guests.",
    feedUrl: "https://feeds.megaphone.fm/APPI6857213837",
    websiteUrl: "https://soundcloud.com/flagrantpodcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/0adac72a-8012-11ef-9b16-bffe28b27ef7/image/84f5c3e24f7864f2fd9f7fc858aa2889.png?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accent: ["#fb7185", "#f97316", "#22c55e"],
  },
  {
    id: "all-in",
    title: "All-In",
    author: "Chamath, Jason, Sacks & Friedberg",
    subtitle: "Markets, tech, politics, and poker",
    description: "Industry veterans cover all things economic, tech, political, social, and poker.",
    feedUrl: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
    websiteUrl: "https://allin.com/",
    imageUrl: "https://static.libsyn.com/p/assets/a/9/c/b/a9cb4d1dadb1ea21/all-in_logo.png",
    accent: ["#0ea5e9", "#a3e635", "#f97316"],
  },
];

export function podcastMediaProxyUrl(showId: string, mediaUrl: string): string {
  return `/api/podcast-media/${encodeURIComponent(showId)}?url=${encodeURIComponent(mediaUrl)}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function attr(block: string, tagName: string, name: string): string {
  const m = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : "";
}

function parseDuration(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const s = Number(trimmed);
    return Number.isFinite(s) && s > 0 ? s : undefined;
  }
  const parts = trimmed.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return undefined;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : undefined;
}

function stableId(showId: string, seed: string): string {
  const key = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return `podcast:${showId}:${key || "episode"}`;
}

// Regex feed parse (no DOMParser in RN). Returns episodes with proxied media URLs.
export function parsePodcastFeed(xmlText: string, show: PodcastShow, limit = 50): PodcastEpisode[] {
  const channelImage = attr(xmlText.split("<item")[0] ?? "", "itunes:image", "href") || show.imageUrl;
  const items = xmlText.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const episodes: PodcastEpisode[] = [];
  for (const block of items) {
    const audioUrl = attr(block, "enclosure", "url");
    if (!audioUrl) continue;
    const title = tag(block, "title") || "Untitled episode";
    const guid = tag(block, "guid");
    const itemImage = attr(block, "itunes:image", "href") || channelImage;
    episodes.push({
      id: stableId(show.id, guid || audioUrl || title),
      title,
      artist: show.title,
      album: "Podcasts",
      imageUrl: podcastMediaProxyUrl(show.id, itemImage),
      audioUrl: podcastMediaProxyUrl(show.id, audioUrl),
      duration: parseDuration(tag(block, "itunes:duration")),
      source: "podcast",
      podcastId: show.id,
      podcastTitle: show.title,
      description: tag(block, "description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      publishedAt: tag(block, "pubDate") || undefined,
    });
    if (episodes.length >= limit) break;
  }
  return episodes;
}
