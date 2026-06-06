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
];

export const HUBERMAN_PODCAST = PODCAST_SHOWS[0];

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
        imageUrl,
        audioUrl,
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
