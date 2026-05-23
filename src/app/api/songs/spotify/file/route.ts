import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/auth";
import {
  AmazonMusicDownloadError,
  normalizeAmazonMusicUrl,
  openAmazonMusicSource,
  resolveAmazonMusicSource,
  type AmazonMusicSource,
} from "@/lib/amazon-music-download";
import {
  QobuzDownloadError,
  resolveQobuzStreamUrl as resolveQobuzProviderStreamUrl,
} from "@/lib/qobuz-download";
import {
  TidalDownloadError,
  resolveTidalStreamUrl as resolveTidalProviderStreamUrl,
} from "@/lib/tidal-download";

export const dynamic = "force-dynamic";

type RequestPayload = {
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  service?: unknown;
};

type ResolvedAudioDownload =
  | {
      service: "qobuz" | "tidal";
      streamUrl: string;
    }
  | {
      service: "amazon";
      amazonSource: AmazonMusicSource;
    };

const REQUEST_TIMEOUT_MS = 120_000;
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

async function resolveAmazonDownload(
  songLinkPayload: Record<string, unknown>,
): Promise<ResolvedAudioDownload> {
  const amazonPlatform = getPlatformLink(songLinkPayload, "amazonMusic");
  const amazonUrl = normalizeAmazonMusicUrl(amazonPlatform?.url ?? "");
  if (!amazonUrl) {
    throw new DownloadError("No Amazon Music mapping found for this Spotify track", 400);
  }
  const amazonSource = await resolveAmazonMusicSource(amazonUrl).catch((error) => {
    if (error instanceof AmazonMusicDownloadError) {
      throw new DownloadError(error.message, error.status);
    }
    throw new DownloadError("Failed to resolve Amazon Music stream", 502);
  });
  return { service: "amazon", amazonSource };
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: RequestPayload,
): Promise<string> {
  const tidalPlatform = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidalPlatform
    ? tryParsePlatformIdFromEntity(tidalPlatform.entityUniqueId, "TIDAL_SONG::")
    : null;
  const urlTrackId = tidalPlatform?.url ? tryParseTrackIdFromUrl(tidalPlatform.url) : null;
  const tidalTrackId = entityTrackId || urlTrackId;

  try {
    return await resolveTidalProviderStreamUrl({
      tidalTrackId: tidalTrackId ?? "",
      title: toStringValue(payload.title),
      artist: toStringValue(payload.artist),
      album: toStringValue(payload.album),
      quality: quality || "LOSSLESS",
    });
  } catch (error) {
    if (error instanceof TidalDownloadError) {
      throw new DownloadError(error.message, error.status);
    }
    throw new DownloadError("Failed to resolve Tidal stream", 502);
  }
}

async function resolveDeezerIsrc(songLinkPayload: Record<string, unknown>): Promise<string> {
  const deezerPlatform = getPlatformLink(songLinkPayload, "deezer");
  if (!deezerPlatform) {
    return "";
  }

  const deezerEntityId = tryParsePlatformIdFromEntity(
    deezerPlatform.entityUniqueId,
    "DEEZER_SONG::",
  );
  const deezerUrlId = deezerPlatform.url ? tryParseTrackIdFromUrl(deezerPlatform.url) : null;
  const deezerTrackId = deezerEntityId || deezerUrlId;
  if (!deezerTrackId || !/^\d+$/.test(deezerTrackId)) {
    return "";
  }

  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerTrackId}`).catch(
    () => null,
  );
  return toStringValue(deezerPayload?.isrc).toUpperCase();
}

async function resolveQobuzDownload(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: RequestPayload,
): Promise<ResolvedAudioDownload> {
  const isrc = await resolveDeezerIsrc(songLinkPayload);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const album = toStringValue(payload.album);
  if (!isrc && !title && !artist) {
    throw new DownloadError("Qobuz needs an ISRC or title/artist metadata", 400);
  }

  try {
    return {
      service: "qobuz",
      streamUrl: await resolveQobuzProviderStreamUrl({
        isrc,
        title,
        artist,
        album,
        quality: quality || "6",
      }),
    };
  } catch (error) {
    if (error instanceof QobuzDownloadError) {
      throw new DownloadError(error.message, error.status);
    }
    throw new DownloadError("Failed to resolve Qobuz stream", 502);
  }
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

async function resolveStreamUrl(payload: RequestPayload): Promise<ResolvedAudioDownload> {
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) {
    throw new DownloadError("Invalid Spotify track URL or ID", 400);
  }

  const songLinkPayload = await fetchSongLinkPayload(
    trackId,
    toStringValue(payload.region).toUpperCase(),
  ).catch(() => ({}));
  const service = toStringValue(payload.service).toLowerCase();
  const qualities = qualityLists(payload);

  if (service === "tidal") {
    const errors: string[] = [];
    for (const quality of qualities.tidal) {
      try {
        return {
          service: "tidal",
          streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload),
        };
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
        return await resolveQobuzDownload(songLinkPayload, quality, payload);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
      }
    }
    throw new DownloadError(`No Qobuz stream found: ${errors.join(" | ")}`, 502);
  }

  if (service === "amazon") {
    return resolveAmazonDownload(songLinkPayload);
  }

  if (service) {
    throw new DownloadError('Unsupported service. Use "tidal", "qobuz", or "amazon".', 400);
  }

  const qobuzErrors: string[] = [];
  for (const quality of qualities.qobuz) {
    try {
      return await resolveQobuzDownload(songLinkPayload, quality, payload);
    } catch (error) {
      qobuzErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }

  const amazonErrors: string[] = [];
  try {
    return await resolveAmazonDownload(songLinkPayload);
  } catch (error) {
    amazonErrors.push(error instanceof Error ? error.message : "Amazon Music failed");
  }

  const tidalErrors: string[] = [];
  for (const quality of qualities.tidal) {
    try {
      return {
        service: "tidal",
        streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload),
      };
    } catch (error) {
      tidalErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }

  throw new DownloadError(
    `No downloadable provider found. Qobuz: ${qobuzErrors.join(" | ")}. Amazon: ${amazonErrors.join(" | ")}. Tidal: ${tidalErrors.join(" | ")}`,
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
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
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
    const resolvedDownload = await resolveStreamUrl(payload);
    let responseBody: BodyInit;
    let responseContentType = "audio/flac";
    let responseContentLength = "";
    let ext = ".flac";

    if (resolvedDownload.service === "amazon") {
      const audio = await openAmazonMusicSource(resolvedDownload.amazonSource).catch((error) => {
        if (error instanceof AmazonMusicDownloadError) {
          throw new DownloadError(error.message, error.status);
        }
        throw new DownloadError("Failed to prepare Amazon Music audio", 502);
      });
      audio.stream.once("close", () => {
        void audio.cleanup();
      });
      audio.stream.once("error", () => {
        void audio.cleanup();
      });
      responseBody = Readable.toWeb(audio.stream) as unknown as BodyInit;
      responseContentType = audio.contentType;
      responseContentLength = audio.size ? String(audio.size) : "";
      ext = audio.extension;
    } else {
      const streamUrl = resolvedDownload.streamUrl;
      const response = await fetchWithTimeout(streamUrl).catch((error) => {
        if (error instanceof DownloadError) throw error;
        throw new DownloadError("Failed to fetch audio stream", 502);
      });
      if (!response.ok || !response.body) {
        throw new DownloadError(`Audio server returned ${response.status}`, 502);
      }
      responseBody = response.body;
      responseContentType = response.headers.get("content-type") || "audio/flac";
      responseContentLength = response.headers.get("content-length") || "";
      ext = extensionFromResponse(response, streamUrl);
    }

    const title = sanitizeFileName(toStringValue(payload.title) || "Track");
    const artist = sanitizeFileName(toStringValue(payload.artist) || "Unknown Artist");
    const filename = `${artist} - ${title}${ext}`;
    const headers = new Headers();
    headers.set("content-type", responseContentType);
    headers.set("content-disposition", `attachment; filename="${filename.replaceAll('"', "'")}"`);
    if (responseContentLength) headers.set("content-length", responseContentLength);
    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    if (error instanceof DownloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to prepare audio download" }, { status: 500 });
  }
}
