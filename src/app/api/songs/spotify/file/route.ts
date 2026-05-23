import { basename, extname } from "node:path";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/auth";

export const dynamic = "force-dynamic";

type RequestPayload = {
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  service?: unknown;
};

const REQUEST_TIMEOUT_MS = 120_000;
const QOBUZ_APP_ID = "798273057";
const TIDAL_API_BASES = [
  "https://api.monochrome.tf",
  "https://arran.monochrome.tf",
  "https://triton.squid.wtf",
  "https://hifi-one.spotisaver.net",
  "https://hifi-two.spotisaver.net",
];
const QOBUZ_STREAM_API_BASES = [
  "https://dab.yeet.su/api/stream?trackId=",
  "https://dabmusic.xyz/api/stream?trackId=",
  "https://qobuz.squid.wtf/api/download-music?track_id=",
];

class DownloadError extends Error {
  status: number;

  constructor(message: string, status = 400) {
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

function sanitizeFileName(value: string): string {
  const safe = basename(value || "track")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "track";
}

function parseSpotifyTrackId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "spotify.com" && host !== "open.spotify.com" && !host.endsWith(".spotify.com")) {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const trackIndex = parts.findIndex((part) => part === "track");
  const trackId = trackIndex >= 0 ? parts[trackIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(trackId) ? trackId : null;
}

function tryParsePlatformIdFromEntity(entityUniqueId: string, prefix: string): string | null {
  if (!entityUniqueId.startsWith(prefix)) return null;
  const value = entityUniqueId.slice(prefix.length).trim();
  return value || null;
}

function tryParseTrackIdFromUrl(url: string): string | null {
  return url.match(/\/track\/([A-Za-z0-9]+)/i)?.[1] ?? null;
}

function decodeBase64Loose(value: string): string | null {
  try {
    const normalized = value.trim().replaceAll("-", "+").replaceAll("_", "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function extractTidalStreamFromManifest(manifestValue: string): string | null {
  const decoded = decodeBase64Loose(manifestValue);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const urls = parsed.urls;
    if (!Array.isArray(urls)) return null;
    const first = urls.find((entry) => typeof entry === "string");
    return typeof first === "string" && first.startsWith("http") ? first : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "waveform/1.0 (+https://local.waveform.app)",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DownloadError("Remote request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonObject(url: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url).catch(() => {
    throw new DownloadError("Upstream request failed", 502);
  });
  if (!response.ok) {
    throw new DownloadError(`Upstream request returned ${response.status}`, 502);
  }
  const payload = toObject(await response.json().catch(() => null));
  if (!payload) {
    throw new DownloadError("Invalid upstream JSON", 502);
  }
  return payload;
}

async function fetchSongLinkPayload(
  spotifyTrackId: string,
  region: string,
): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${spotifyTrackId}`;
  const params = new URLSearchParams({ url: spotifyUrl });
  if (region) params.set("userCountry", region);
  return fetchJsonObject(`https://api.song.link/v1-alpha.1/links?${params.toString()}`);
}

function getPlatformLink(
  songLinkPayload: Record<string, unknown>,
  platform: string,
): { url: string; entityUniqueId: string } | null {
  const linksByPlatform = toObject(songLinkPayload.linksByPlatform);
  if (!linksByPlatform) return null;
  const platformData = toObject(linksByPlatform[platform]);
  if (!platformData) return null;
  const url = toStringValue(platformData.url);
  const entityUniqueId = toStringValue(platformData.entityUniqueId);
  if (!url && !entityUniqueId) return null;
  return { url, entityUniqueId };
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
): Promise<string> {
  const tidalPlatform = getPlatformLink(songLinkPayload, "tidal");
  if (!tidalPlatform) {
    throw new DownloadError("No Tidal mapping found for this Spotify track", 400);
  }

  const entityTrackId = tryParsePlatformIdFromEntity(
    tidalPlatform.entityUniqueId,
    "TIDAL_SONG::",
  );
  const urlTrackId = tidalPlatform.url ? tryParseTrackIdFromUrl(tidalPlatform.url) : null;
  const tidalTrackId = entityTrackId || urlTrackId;
  if (!tidalTrackId || !/^\d+$/.test(tidalTrackId)) {
    throw new DownloadError("Could not resolve Tidal track ID", 400);
  }

  const requestedQuality = quality || "LOSSLESS";
  let lastError = "";

  for (const apiBase of TIDAL_API_BASES) {
    const apiUrl = `${apiBase}/track/?id=${tidalTrackId}&quality=${encodeURIComponent(requestedQuality)}`;
    try {
      const response = await fetchWithTimeout(apiUrl);
      if (!response.ok) {
        lastError = `${apiBase} returned ${response.status}`;
        continue;
      }
      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        lastError = `${apiBase} returned non-JSON data`;
        continue;
      }

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const row = toObject(item);
          const directUrl = row ? toStringValue(row.OriginalTrackUrl) : "";
          if (directUrl.startsWith("http")) return directUrl;
        }
      }

      const objectPayload = toObject(parsed);
      if (!objectPayload) {
        lastError = `${apiBase} response shape is unsupported`;
        continue;
      }

      const directUrl = toStringValue(objectPayload.OriginalTrackUrl);
      if (directUrl.startsWith("http")) return directUrl;

      const data = toObject(objectPayload.data);
      const manifest = data ? toStringValue(data.manifest || data.Manifest) : "";
      const manifestUrl = manifest ? extractTidalStreamFromManifest(manifest) : null;
      if (manifestUrl) return manifestUrl;

      lastError = `${apiBase} had no stream URL`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : `${apiBase} request failed`;
    }
  }

  throw new DownloadError(
    lastError ? `Failed to resolve Tidal stream (${lastError})` : "Failed to resolve Tidal stream",
    502,
  );
}

async function resolveQobuzStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
): Promise<string> {
  const deezerPlatform = getPlatformLink(songLinkPayload, "deezer");
  if (!deezerPlatform) {
    throw new DownloadError("No Deezer mapping found for this Spotify track", 400);
  }

  const deezerEntityId = tryParsePlatformIdFromEntity(
    deezerPlatform.entityUniqueId,
    "DEEZER_SONG::",
  );
  const deezerUrlId = deezerPlatform.url ? tryParseTrackIdFromUrl(deezerPlatform.url) : null;
  const deezerTrackId = deezerEntityId || deezerUrlId;
  if (!deezerTrackId || !/^\d+$/.test(deezerTrackId)) {
    throw new DownloadError("Could not resolve Deezer track ID for ISRC lookup", 400);
  }

  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerTrackId}`);
  const isrc = toStringValue(deezerPayload.isrc);
  if (!isrc) {
    throw new DownloadError("Could not resolve ISRC from Deezer", 400);
  }

  const qobuzSearchUrl = `https://www.qobuz.com/api.json/0.2/track/search?query=${encodeURIComponent(
    isrc,
  )}&limit=1&app_id=${QOBUZ_APP_ID}`;
  const qobuzSearchPayload = await fetchJsonObject(qobuzSearchUrl);
  const tracks = toObject(qobuzSearchPayload.tracks);
  const items = tracks?.items;
  const firstTrack = Array.isArray(items) ? toObject(items[0]) : null;
  const qobuzTrackIdValue = firstTrack?.id;
  const qobuzTrackId =
    typeof qobuzTrackIdValue === "number"
      ? `${qobuzTrackIdValue}`
      : typeof qobuzTrackIdValue === "string"
        ? qobuzTrackIdValue
        : "";
  if (!qobuzTrackId || !/^\d+$/.test(qobuzTrackId)) {
    throw new DownloadError("Could not resolve Qobuz track ID", 400);
  }

  const requestedQuality = quality || "6";
  let lastError = "";
  for (const apiBase of QOBUZ_STREAM_API_BASES) {
    const apiUrl = `${apiBase}${qobuzTrackId}&quality=${encodeURIComponent(requestedQuality)}`;
    try {
      const response = await fetchWithTimeout(apiUrl);
      if (!response.ok) {
        lastError = `${apiBase} returned ${response.status}`;
        continue;
      }
      const payload = toObject(await response.json().catch(() => null));
      if (!payload) {
        lastError = `${apiBase} returned invalid JSON shape`;
        continue;
      }
      const rootUrl = toStringValue(payload.url);
      if (rootUrl.startsWith("http")) return rootUrl;
      const data = toObject(payload.data);
      const nestedUrl = data ? toStringValue(data.url) : "";
      if (nestedUrl.startsWith("http")) return nestedUrl;
      lastError = `${apiBase} had no stream URL`;
    } catch {
      lastError = `${apiBase} request failed`;
    }
  }

  throw new DownloadError(
    lastError ? `Failed to resolve Qobuz stream (${lastError})` : "Failed to resolve Qobuz stream",
    502,
  );
}

function qualityLists(payload: RequestPayload) {
  const qualityRaw = toStringValue(payload.quality);
  const profileRaw = toStringValue(payload.qualityProfile).toLowerCase();
  const qualityProfile = ["cd", "hires48", "max"].includes(profileRaw) ? profileRaw : "max";
  const qobuz =
    qualityProfile === "cd"
      ? ["6"]
      : qualityProfile === "hires48"
        ? ["7", "6"]
        : ["27", "7", "6"];
  const tidal =
    qualityProfile === "cd"
      ? ["LOSSLESS", "HIGH"]
      : qualityProfile === "hires48"
        ? ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH"]
        : ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH"];
  return {
    qobuz: qualityRaw ? [qualityRaw] : qobuz,
    tidal: qualityRaw ? [qualityRaw] : tidal,
  };
}

async function resolveStreamUrl(payload: RequestPayload): Promise<string> {
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) {
    throw new DownloadError("Invalid Spotify track URL or ID", 400);
  }

  const songLinkPayload = await fetchSongLinkPayload(trackId, toStringValue(payload.region).toUpperCase());
  const service = toStringValue(payload.service).toLowerCase();
  const qualities = qualityLists(payload);

  if (service === "tidal") {
    const errors: string[] = [];
    for (const quality of qualities.tidal) {
      try {
        return await resolveTidalStreamUrl(songLinkPayload, quality);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
      }
    }
    throw new DownloadError(`No Tidal stream found: ${errors.join(" | ")}`, 502);
  }

  if (service === "qobuz") {
    const errors: string[] = [];
    for (const quality of qualities.qobuz) {
      try {
        return await resolveQobuzStreamUrl(songLinkPayload, quality);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
      }
    }
    throw new DownloadError(`No Qobuz stream found: ${errors.join(" | ")}`, 502);
  }

  if (service) {
    throw new DownloadError('Unsupported service. Use "tidal" or "qobuz".', 400);
  }

  const qobuzErrors: string[] = [];
  for (const quality of qualities.qobuz) {
    try {
      return await resolveQobuzStreamUrl(songLinkPayload, quality);
    } catch (error) {
      qobuzErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }

  const tidalErrors: string[] = [];
  for (const quality of qualities.tidal) {
    try {
      return await resolveTidalStreamUrl(songLinkPayload, quality);
    } catch (error) {
      tidalErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }

  throw new DownloadError(
    `No downloadable provider found. Qobuz: ${qobuzErrors.join(" | ")}. Tidal: ${tidalErrors.join(" | ")}`,
    502,
  );
}

function extensionFromResponse(response: Response, streamUrl: string): string {
  const urlExt = extname(new URL(streamUrl).pathname).toLowerCase();
  if (urlExt) return urlExt;
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  return ".flac";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: RequestPayload;
  try {
    payload = (await req.json()) as RequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const streamUrl = await resolveStreamUrl(payload);
    const response = await fetchWithTimeout(streamUrl).catch((error) => {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError("Failed to fetch audio stream", 502);
    });
    if (!response.ok || !response.body) {
      throw new DownloadError(`Audio server returned ${response.status}`, 502);
    }

    const title = sanitizeFileName(toStringValue(payload.title) || "Track");
    const artist = sanitizeFileName(toStringValue(payload.artist) || "Unknown Artist");
    const ext = extensionFromResponse(response, streamUrl);
    const filename = `${artist} - ${title}${ext}`;
    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") || "audio/flac");
    headers.set("content-disposition", `attachment; filename="${filename.replaceAll('"', "'")}"`);
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers.set("content-length", contentLength);
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof DownloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to prepare audio download" }, { status: 500 });
  }
}
