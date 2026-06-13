import type { PlayerSong } from "@/types/player";

export type PodcastShow = {
  id: string;
  title: string;
  author: string;
  subtitle: string;
  description: string;
  feedUrl: string;
  websiteUrl: string;
  imageUrl: string;
  accentClassName: string;
};

export type PodcastEpisode = PlayerSong & {
  source: "podcast";
  podcastId: string;
  podcastTitle: string;
  description: string;
  link?: string;
  publishedAt?: string;
};

export const PODCAST_SHOWS: PodcastShow[] = [
  {
    id: "huberman-lab",
    title: "Huberman Lab",
    author: "Andrew Huberman, Ph.D.",
    subtitle: "Neuroscience and science-based tools",
    description:
      "Neuroscience, health, and performance conversations with Andrew Huberman and guests.",
    feedUrl: "https://feeds.megaphone.fm/hubermanlab",
    websiteUrl: "https://www.hubermanlab.com/podcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/042e6144-725e-11ec-a75d-c38f702aecad/image/ee4f0b7b466ca35620792970d9bce2d2.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accentClassName: "from-[#1ed760] via-[#06b6d4] to-[#f97316]",
  },
  {
    id: "modern-wisdom",
    title: "Modern Wisdom",
    author: "Chris Williamson",
    subtitle: "Lessons from the greatest thinkers on the planet",
    description:
      "Life lessons, ideas, and tactics for navigating modern life with Chris Williamson and guests.",
    feedUrl: "https://feeds.megaphone.fm/SIXMSB5088139739",
    websiteUrl: "https://chriswillx.com/podcast/",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/a62f84c0-f8b6-11ed-a4fc-fb9e7841d45b/image/76ed638554a4be965517200d1cd5f30d.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accentClassName: "from-[#f97316] via-[#facc15] to-[#7c3aed]",
  },
  {
    id: "flagrant",
    title: "Flagrant",
    author: "Andrew Schulz",
    subtitle: "Unfiltered comedy and culture",
    description:
      "Unfiltered comedy, culture, and unruly conversations with Andrew Schulz, AlexxMedia, Mark Gagnon, and guests.",
    feedUrl: "https://feeds.megaphone.fm/APPI6857213837",
    websiteUrl: "https://soundcloud.com/flagrantpodcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/0adac72a-8012-11ef-9b16-bffe28b27ef7/image/84f5c3e24f7864f2fd9f7fc858aa2889.png?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
    accentClassName: "from-[#fb7185] via-[#f97316] to-[#22c55e]",
  },
  {
    id: "all-in",
    title: "All-In",
    author: "Chamath Palihapitiya, Jason Calacanis, David Sacks & David Friedberg",
    subtitle: "Markets, tech, politics, and poker",
    description:
      "Industry veterans, degenerate gamblers, and besties cover all things economic, tech, political, social, and poker.",
    feedUrl: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
    websiteUrl: "https://allin.com/",
    imageUrl:
      "https://static.libsyn.com/p/assets/a/9/c/b/a9cb4d1dadb1ea21/all-in_logo.png",
    accentClassName: "from-[#0ea5e9] via-[#a3e635] to-[#f97316]",
  },
];

function firstElementByTag(parent: Element | Document | null | undefined, tagName: string): Element | null {
  return parent?.getElementsByTagName(tagName).item(0) ?? null;
}

function textOf(element: Element | null): string {
  return normalizeText(element?.textContent ?? "");
}

function attrOf(element: Element | null, name: string): string {
  return normalizeText(element?.getAttribute(name) ?? "");
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function safePodcastUrl(value: string, baseUrl?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

// Podcast media is served through this same-origin Worker proxy instead of the
// third-party feed CDNs so the offline download pipeline and the service
// worker (which both only handle same-origin URLs) work for episodes too.
export function podcastMediaProxyUrl(showId: string, mediaUrl: string): string {
  return `/api/podcast-media/${encodeURIComponent(showId)}?url=${encodeURIComponent(mediaUrl)}`;
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => safeCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The Worker validates /api/podcast-media requests against the show's feed so
// the proxy can't be used as an open relay. It has no XML parser, so candidate
// URLs (enclosure url=, itunes:image href=, <url> elements) are pulled from
// the raw feed text with regexes instead of mirroring parsePodcastFeed.
export function extractPodcastFeedMediaUrls(xmlText: string, show: PodcastShow): Set<string> {
  const urls = new Set<string>();
  const add = (raw: string) => {
    const normalized = safePodcastUrl(decodeXmlEntities(raw), show.feedUrl);
    if (normalized) urls.add(normalized);
  };
  add(show.imageUrl);
  // Only pull URLs from media-bearing tags (enclosure / media:content /
  // itunes:image) and <url> elements — never from arbitrary href= in show-notes
  // HTML, which would let an episode turn this proxy into a relay for any link
  // it happens to cite.
  for (const tag of xmlText.matchAll(/<(?:enclosure|media:content|itunes:image)\b[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:url|href)=(?:"([^"]*)"|'([^']*)')/gi)) {
      add(attr[1] ?? attr[2] ?? "");
    }
  }
  for (const match of xmlText.matchAll(/<url>([^<]*)<\/url>/gi)) {
    add(match[1]);
  }
  return urls;
}

function urlOriginAndPath(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function podcastFeedAllowsMediaUrl(allowedUrls: Set<string>, mediaUrl: string): boolean {
  if (allowedUrls.has(mediaUrl)) return true;
  // Tracking params (e.g. megaphone's ?updated=) can drift between the feed
  // snapshot the client parsed and the one the validator fetched, so fall
  // back to matching on origin + path.
  const target = urlOriginAndPath(mediaUrl);
  if (!target) return false;
  for (const allowed of allowedUrls) {
    if (urlOriginAndPath(allowed) === target) return true;
  }
  return false;
}

function stripHtml(value: string): string {
  const trimmed = value.trim();
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) return normalizeText(trimmed);

  try {
    const html = new DOMParser().parseFromString(trimmed, "text/html");
    return normalizeText(html.body.textContent ?? trimmed);
  } catch {
    return normalizeText(trimmed.replace(/<[^>]*>/g, " "));
  }
}

function parseDurationSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }

  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return totalSeconds > 0 ? totalSeconds : undefined;
}

function isoDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function stableEpisodeId(showId: string, item: Element, audioUrl: string, title: string): string {
  const guid = textOf(firstElementByTag(item, "guid"));
  const seed = guid || audioUrl || title;
  const key = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `podcast:${showId}:${key || "episode"}`;
}

export function parsePodcastFeed(xmlText: string, show: PodcastShow, limit = 50): PodcastEpisode[] {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (firstElementByTag(xml, "parsererror")) {
    throw new Error("Podcast feed could not be parsed");
  }

  const channel = firstElementByTag(xml, "channel");
  if (!channel) throw new Error("Podcast feed is missing a channel");

  const channelTitle = textOf(firstElementByTag(channel, "title")) || show.title;
  const channelAuthor = textOf(firstElementByTag(channel, "itunes:author")) || show.author;
  const imageContainer = firstElementByTag(channel, "image");
  const channelImage =
    safePodcastUrl(textOf(firstElementByTag(imageContainer, "url")), show.feedUrl) ||
    safePodcastUrl(attrOf(firstElementByTag(channel, "itunes:image"), "href"), show.feedUrl) ||
    show.imageUrl;

  return Array.from(channel.getElementsByTagName("item"))
    .map((item): PodcastEpisode | null => {
      const enclosure = firstElementByTag(item, "enclosure");
      const audioUrl = safePodcastUrl(attrOf(enclosure, "url"), show.feedUrl);
      if (!audioUrl) return null;

      const title = textOf(firstElementByTag(item, "title")) || "Untitled episode";
      const description =
        stripHtml(textOf(firstElementByTag(item, "description"))) ||
        stripHtml(textOf(firstElementByTag(item, "content:encoded")));
      const duration = parseDurationSeconds(textOf(firstElementByTag(item, "itunes:duration")));
      const publishedAt = isoDate(textOf(firstElementByTag(item, "pubDate")));
      const imageUrl =
        safePodcastUrl(attrOf(firstElementByTag(item, "itunes:image"), "href"), show.feedUrl) ||
        channelImage;

      return {
        id: stableEpisodeId(show.id, item, audioUrl, title),
        title,
        artist: channelTitle || channelAuthor || show.title,
        album: "Podcasts",
        imageUrl: podcastMediaProxyUrl(show.id, imageUrl),
        audioUrl: podcastMediaProxyUrl(show.id, audioUrl),
        createdAt: publishedAt,
        duration,
        source: "podcast",
        podcastId: show.id,
        podcastTitle: channelTitle,
        description,
        link: safePodcastUrl(textOf(firstElementByTag(item, "link")), show.websiteUrl) || show.websiteUrl,
        publishedAt,
      };
    })
    .filter((episode): episode is PodcastEpisode => episode != null)
    .slice(0, limit);
}
