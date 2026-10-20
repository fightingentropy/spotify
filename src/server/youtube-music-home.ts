// The owner's YouTube Music Home, reduced to its playlist shelves ("Listen again",
// "Mixed for you", "From the community", …). yt-dlp has no extractor for the Home
// feed, so this calls the web client's innertube browse API directly, signed with
// the same Premium cookie jar yt-dlp uses. Each card id is "yt-mix-<listId>", the
// read-through playlist route every client already opens.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_USER_AGENT, toObject, toStringValue } from "../lib/provider-http";
import { isValidYouTubePlaylistId, trustedYouTubeThumbnail } from "./youtube-preview";

export type YouTubeMusicHomePlaylist = { id: string; name: string; subtitle: string; imageUrl: string | null };
export type YouTubeMusicHomeShelf = { id: string; title: string; eyebrow?: string; playlists: YouTubeMusicHomePlaylist[] };

const ORIGIN = "https://music.youtube.com";
// Home arrives in pages of about three shelves; eight pages covers the full feed.
const MAX_PAGES = 8;
const REQUEST_TIMEOUT_MS = 8_000;

function at(value: unknown, ...keys: Array<string | number>): unknown {
  for (const key of keys) value = typeof key === "number" ? (Array.isArray(value) ? value[key] : undefined) : toObject(value)?.[key];
  return value;
}
function rows(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
// Runs keep their own spacing (" • " separators), so only the joined text is trimmed.
function text(value: unknown): string {
  return rows(at(value, "runs")).map((run) => {
    const part = at(run, "text");
    return typeof part === "string" ? part : "";
  }).join("").replace(/\s+/g, " ").trim();
}

// The mini's jar is a full browser export. Only youtube.com cookies may leave
// this process, so every other domain is dropped while parsing.
export function youtubeCookiesFromJar(jar: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const line of jar.split(/\r?\n/)) {
    const raw = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
    if (!raw || raw.startsWith("#")) continue;
    const fields = raw.split("\t");
    if (fields.length < 7) continue;
    const domain = fields[0].toLowerCase();
    if (domain !== "youtube.com" && domain !== ".youtube.com" && !domain.endsWith(".youtube.com")) continue;
    const name = fields[5].trim();
    if (name) cookies.set(name, fields[6].trim());
  }
  return cookies;
}

export function youtubeMusicAuthorization(sapisid: string, nowSeconds: number): string {
  const hash = createHash("sha1").update(`${nowSeconds} ${sapisid} ${ORIGIN}`).digest("hex");
  return `SAPISIDHASH ${nowSeconds}_${hash}`;
}

// Generated mix covers ("My Supermix", "Discover Mix") are public images served
// from music.youtube.com itself rather than an image CDN.
function mixArtwork(value: unknown): string | null {
  try {
    const url = new URL(toStringValue(value));
    return url.protocol === "https:" && url.hostname === "music.youtube.com" && url.pathname === "/image/mixart" ? url.toString() : null;
  } catch {
    return null;
  }
}

// Home thumbnails are 226px. lh3/ggpht URLs carry their size, so ask for one that
// stays sharp on a retina card; i.ytimg.com URLs are left as they are.
function cardImage(renderer: unknown): string | null {
  const thumbnails = rows(at(renderer, "thumbnailRenderer", "musicThumbnailRenderer", "thumbnail", "thumbnails"));
  for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
    const raw = at(thumbnails[index], "url");
    const url = trustedYouTubeThumbnail(raw) ?? mixArtwork(raw);
    if (url) return url.replace(/=w\d+-h\d+(?=[-?]|$)/, "=w544-h544");
  }
  return null;
}

function playlistCard(item: unknown): YouTubeMusicHomePlaylist | null {
  const renderer = at(item, "musicTwoRowItemRenderer");
  const browse = at(renderer, "navigationEndpoint", "browseEndpoint");
  const pageType = toStringValue(at(browse, "browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig", "pageType"));
  const browseId = toStringValue(at(browse, "browseId"));
  if (pageType !== "MUSIC_PAGE_TYPE_PLAYLIST" || !browseId.startsWith("VL")) return null;
  // "LM" (YouTube's Liked Music) fails the id check on purpose: Liked Songs is
  // the library's own collection here.
  const listId = browseId.slice(2);
  const name = text(at(renderer, "title"));
  if (!isValidYouTubePlaylistId(listId) || !name) return null;
  return { id: `yt-mix-${listId}`, name, subtitle: text(at(renderer, "subtitle")), imageUrl: cardImage(renderer) };
}

// Songs, albums, artists and podcasts are dropped; a shelf with no playlists left
// is dropped with them.
export function parseYouTubeMusicHomeShelves(sections: unknown[]): YouTubeMusicHomeShelf[] {
  const shelves: YouTubeMusicHomeShelf[] = [];
  const shelfIds = new Set<string>();
  for (const section of sections) {
    const shelf = at(section, "musicCarouselShelfRenderer");
    const header = at(shelf, "header", "musicCarouselShelfBasicHeaderRenderer");
    const title = text(at(header, "title"));
    if (!title) continue;
    const seen = new Set<string>();
    const playlists: YouTubeMusicHomePlaylist[] = [];
    for (const item of rows(at(shelf, "contents"))) {
      const card = playlistCard(item);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      playlists.push(card);
    }
    if (!playlists.length) continue;
    const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shelf";
    let id = slug;
    for (let suffix = 2; shelfIds.has(id); suffix += 1) id = `${slug}-${suffix}`;
    shelfIds.add(id);
    const eyebrow = text(at(header, "strapline"));
    shelves.push({ id, title, ...(eyebrow ? { eyebrow } : {}), playlists });
  }
  return shelves;
}

export async function fetchYouTubeMusicHome(options: {
  cookiesFile: string;
  // Which signed-in Google account in the jar to read, as YouTube's authuser index.
  authUser: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}): Promise<YouTubeMusicHomeShelf[]> {
  const cookies = youtubeCookiesFromJar(await readFile(options.cookiesFile, "utf8"));
  const sapisid = cookies.get("SAPISID") || cookies.get("__Secure-3PAPISID");
  if (!sapisid) throw new Error("The YouTube cookie jar has no signed-in session");
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const version = new Date(nowSeconds() * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

  const browse = async (query: string, body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchImpl(`${ORIGIN}/youtubei/v1/browse?prettyPrint=false${query}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-origin": ORIGIN,
        "x-goog-authuser": options.authUser,
        authorization: youtubeMusicAuthorization(sapisid, nowSeconds()),
        cookie: cookieHeader,
        "user-agent": DEFAULT_USER_AGENT,
      },
      body: JSON.stringify({ context: { client: { clientName: "WEB_REMIX", clientVersion: `1.${version}.01.00`, hl: "en" } }, ...body }),
    });
    if (!response.ok) throw new Error(`YouTube Music returned ${response.status}`);
    return response.json();
  };

  const first = await browse("", { browseId: "FEmusic_home" });
  const list = at(first, "contents", "singleColumnBrowseResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer");
  const sections = [...rows(at(list, "contents"))];
  let continuation = toStringValue(at(list, "continuations", 0, "nextContinuationData", "continuation"));
  for (let page = 1; continuation && page < MAX_PAGES; page += 1) {
    const token = encodeURIComponent(continuation);
    // A later page failing still leaves the shelves already read.
    const next = await browse(`&ctoken=${token}&continuation=${token}&type=next`, {}).catch(() => null);
    const more = at(next, "continuationContents", "sectionListContinuation");
    sections.push(...rows(at(more, "contents")));
    continuation = toStringValue(at(more, "continuations", 0, "nextContinuationData", "continuation"));
  }
  return parseYouTubeMusicHomeShelves(sections);
}
