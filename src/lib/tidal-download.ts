import { createHash } from "node:crypto";

const GDSTUDIO_VERSION = "2026.5.10";
const GDSTUDIO_HOSTS = ["music.gdstudio.xyz", "music.gdstudio.org"];
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

type GDStudioSearchTrack = {
  id?: unknown;
  name?: unknown;
  artist?: unknown;
  album?: unknown;
  source?: unknown;
  extra_data?: unknown;
};

export class TidalDownloadError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeSearchValue(value: string): string {
  const replacer = new Map([
    ["&", " and "],
    ["feat.", " "],
    ["ft.", " "],
    ["/", " "],
    ["-", " "],
    ["_", " "],
  ]);
  let normalized = value.toLowerCase().trim();
  for (const [from, to] of replacer) {
    normalized = normalized.replaceAll(from, to);
  }
  return normalized.split(/\s+/).filter(Boolean).join(" ");
}

function gdStudioPaddedVersion(): string {
  return GDSTUDIO_VERSION.split(".")
    .map((part) => (part.trim().length === 1 ? `0${part.trim()}` : part.trim()))
    .join("");
}

function gdStudioUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/!/g, "%21");
}

async function fetchWithTimeout(
  url: string,
  options?: {
    method?: string;
    body?: BodyInit;
    headers?: HeadersInit;
    timeoutMs?: number;
  },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const headers = new Headers(options?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_USER_AGENT);
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/plain, */*");
  }

  try {
    return await fetch(url, {
      method: options?.method ?? "GET",
      body: options?.body,
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TidalDownloadError("Tidal provider request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function gdStudioTimestamp(host: string): Promise<string> {
  const response = await fetchWithTimeout(`https://${host}/time`, { timeoutMs: 8_000 }).catch(
    () => null,
  );
  const value = response?.ok ? await response.text().catch(() => "") : "";
  const fallback = `${Date.now()}`;
  const timestamp = (value.trim() || fallback).slice(0, 9);
  return timestamp || fallback.slice(0, 9);
}

async function gdStudioSignature(host: string, value: string): Promise<string> {
  const timestamp = await gdStudioTimestamp(host);
  const signatureBase = `${host}|${gdStudioPaddedVersion()}|${timestamp}|${value}`;
  const digest = createHash("md5").update(signatureBase).digest("hex").toUpperCase();
  return digest.slice(-8);
}

function mapTidalQualityToBitrate(quality: string): string {
  const normalized = quality.trim().toUpperCase();
  if (normalized === "HI_RES" || normalized === "HI_RES_LOSSLESS" || normalized === "MAX") {
    return "999";
  }
  if (normalized === "LOSSLESS" || normalized === "FLAC" || normalized === "CD") {
    return "740";
  }
  if (normalized === "LOW") {
    return "128";
  }
  return "320";
}

function tidalTrackDisplayArtist(track: GDStudioSearchTrack): string {
  if (Array.isArray(track.artist)) {
    return track.artist.map(toStringValue).filter(Boolean).join(", ");
  }
  return toStringValue(track.artist);
}

function scoreTidalSearchCandidate(
  track: GDStudioSearchTrack,
  title: string,
  artist: string,
  album: string,
): number {
  let score = 0;
  const titleNeedle = normalizeSearchValue(title);
  const titleHaystack = normalizeSearchValue(toStringValue(track.name));
  if (titleNeedle && titleHaystack === titleNeedle) {
    score += 1000;
  } else if (
    titleNeedle &&
    (titleHaystack.includes(titleNeedle) || titleNeedle.includes(titleHaystack))
  ) {
    score += 500;
  }

  const artistNeedle = normalizeSearchValue(artist);
  const artistHaystack = normalizeSearchValue(tidalTrackDisplayArtist(track));
  if (artistNeedle && artistHaystack === artistNeedle) {
    score += 300;
  } else if (
    artistNeedle &&
    artistHaystack &&
    (artistHaystack.includes(artistNeedle) || artistNeedle.includes(artistHaystack))
  ) {
    score += 180;
  }

  const albumNeedle = normalizeSearchValue(album);
  const albumHaystack = normalizeSearchValue(toStringValue(track.album));
  if (albumNeedle && albumHaystack === albumNeedle) {
    score += 150;
  } else if (
    albumNeedle &&
    albumHaystack &&
    (albumHaystack.includes(albumNeedle) || albumNeedle.includes(albumHaystack))
  ) {
    score += 90;
  }

  const extraData = toObject(track.extra_data);
  if (extraData?.is_available === true) {
    score += 50;
  }
  if (extraData?.has_hires === true) {
    score += 20;
  }
  return score;
}

async function gdStudioSearchTidalTrack(
  host: string,
  query: string,
): Promise<GDStudioSearchTrack[]> {
  const encodedQuery = gdStudioUrlEncode(query);
  const signature = await gdStudioSignature(host, encodedQuery);
  const body = `types=search&count=10&source=tidal&pages=1&name=${encodedQuery}&s=${signature}`;
  const response = await fetchWithTimeout(`https://${host}/api.php`, {
    method: "POST",
    timeoutMs: 25_000,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: `https://${host}`,
      referer: `https://${host}/`,
    },
    body,
  });
  if (!response.ok) {
    throw new TidalDownloadError(`GDStudio search returned ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload) ? (payload as GDStudioSearchTrack[]) : [];
}

async function resolveTidalTrackIdFromSearch(options: {
  title?: string;
  artist?: string;
  album?: string;
}): Promise<string> {
  const title = toStringValue(options.title);
  const artist = toStringValue(options.artist);
  const album = toStringValue(options.album);
  const queries = Array.from(new Set([
    [title, artist].filter(Boolean).join(" "),
    [title, artist, album].filter(Boolean).join(" "),
    title,
  ].filter(Boolean)));
  let lastError = "";

  for (const query of queries) {
    for (const host of GDSTUDIO_HOSTS) {
      try {
        const results = await gdStudioSearchTidalTrack(host, query);
        let selected: GDStudioSearchTrack | null = null;
        let selectedScore = -1;
        for (const result of results) {
          if (toStringValue(result.source) !== "tidal") continue;
          const id = toStringValue(result.id);
          if (!id) continue;
          const score = scoreTidalSearchCandidate(result, title, artist, album);
          if (score > selectedScore) {
            selected = result;
            selectedScore = score;
          }
        }
        const selectedId = selected ? toStringValue(selected.id) : "";
        if (selectedId) return selectedId;
        lastError = `Tidal track not found for query: ${query}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : `Tidal search failed for ${query}`;
      }
    }
  }

  throw new TidalDownloadError(lastError || "Could not resolve Tidal track", 400);
}

async function downloadFromGDStudioTidal(
  host: string,
  trackId: string,
  quality: string,
): Promise<string> {
  const encodedTrackId = gdStudioUrlEncode(trackId);
  const signature = await gdStudioSignature(host, encodedTrackId);
  const body = `types=url&id=${encodedTrackId}&source=tidal&br=${mapTidalQualityToBitrate(quality)}&s=${signature}`;
  const response = await fetchWithTimeout(`https://${host}/api.php`, {
    method: "POST",
    timeoutMs: 25_000,
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: `https://${host}`,
      referer: `https://${host}/`,
    },
    body,
  });
  if (!response.ok) {
    throw new TidalDownloadError(`GDStudio returned ${response.status}`);
  }
  const payload = toObject(await response.json().catch(() => null));
  const streamUrl = toStringValue(payload?.url);
  if (streamUrl.startsWith("http")) return streamUrl;
  throw new TidalDownloadError("GDStudio returned no Tidal stream URL");
}

export async function resolveTidalStreamUrl(options: {
  tidalTrackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  quality: string;
}): Promise<string> {
  const directTrackId = toStringValue(options.tidalTrackId);
  const trackIds = directTrackId && /^\d+$/.test(directTrackId) ? [directTrackId] : [];
  const hasSearchMetadata = Boolean(toStringValue(options.title) || toStringValue(options.artist));
  const errors: string[] = [];
  const tryTrackIds = async (ids: string[]): Promise<string> => {
    for (const trackId of ids) {
      for (const host of GDSTUDIO_HOSTS) {
        try {
          return await downloadFromGDStudioTidal(host, trackId, options.quality || "LOSSLESS");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `${host} failed`);
        }
      }
    }
    return "";
  };

  const directStreamUrl = await tryTrackIds(trackIds);
  if (directStreamUrl) return directStreamUrl;

  if (hasSearchMetadata) {
    const searchTrackId = await resolveTidalTrackIdFromSearch(options).catch((error) => {
      errors.push(error instanceof Error ? error.message : "Could not resolve Tidal track");
      return "";
    });
    const fallbackTrackIds =
      searchTrackId && !trackIds.includes(searchTrackId) ? [searchTrackId] : [];
    const searchStreamUrl = await tryTrackIds(fallbackTrackIds);
    if (searchStreamUrl) return searchStreamUrl;
  }

  if (trackIds.length === 0 && !hasSearchMetadata) {
    throw new TidalDownloadError("Tidal needs a track ID or title/artist metadata", 400);
  }

  throw new TidalDownloadError(
    errors.length > 0
      ? `Tidal stream providers are currently unavailable: ${errors.join(" | ")}`
      : "Tidal stream providers are currently unavailable",
  );
}
