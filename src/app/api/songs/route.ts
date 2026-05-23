import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/auth";
import { basename, extname, join } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { parseFile } from "music-metadata";
import {
  getObjectAbsolutePath,
  putObjectFromBuffer,
  putObjectFromStream,
} from "@/lib/storage";
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
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";

export const dynamic = "force-dynamic";

type UploadedFile = {
  fileName: string;
  key: string;
  contentType: string;
};

type UploadFailure = {
  status: number;
  message: string;
};

type LinkSongPayload = {
  mode?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  spotifyUrl?: unknown;
  service?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  region?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
};

type LinkSongData = {
  title: string;
  artist: string;
  image: UploadedFile | null;
  audio: UploadedFile;
  lyricsText?: string;
  audioBitDepth: number | null;
  audioSampleRate: number | null;
};

type ResolvedSpotifyAudioDownload =
  | {
      service: "qobuz" | "tidal";
      streamUrl: string;
    }
  | {
      service: "amazon";
      amazonSource: AmazonMusicSource;
    };

const IMAGE_EXT_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const AUDIO_EXT_TYPES = new Map<string, string>([
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp4", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mpeg", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

const IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const AUDIO_MIME_TYPES = new Set<string>([
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

const MAX_IMAGE_BYTES = env.UPLOAD_MAX_IMAGE_BYTES;
const MAX_AUDIO_BYTES = env.UPLOAD_MAX_AUDIO_BYTES;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 120_000;
const TIDAL_API_BASES = [
  "https://api.monochrome.tf",
  "https://arran.monochrome.tf",
  "https://triton.squid.wtf",
  "https://hifi-one.spotisaver.net",
  "https://hifi-two.spotisaver.net",
];

class UploadError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${bytes} bytes`;
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName || "upload");
  const safe = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return safe || "upload";
}

function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9.\-_ ]/g, "_").replace(/\s+/g, " ");
  return safe || "unknown";
}

function buildOrganizedMusicBasePath(title: string, artist: string): string {
  return join("music", sanitizePathSegment(artist), sanitizePathSegment(title)).replaceAll("\\", "/");
}

function toApiFileUrl(key: string): string {
  return `/api/files/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function parseStorageKeyFromApiUrl(url: string): string | null {
  if (!url.startsWith("/api/files/")) {
    return null;
  }
  const encoded = url.slice("/api/files/".length).trim();
  if (!encoded) {
    return null;
  }
  return encoded
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
}

type AudioQuality = {
  audioBitDepth: number | null;
  audioSampleRate: number | null;
};

// In-memory LRU cache for parsed audio metadata keyed by storage key.
// The underlying file is immutable (upload writes a fresh key) so the parse
// result is safe to cache for the lifetime of the process.
const AUDIO_QUALITY_CACHE_LIMIT = 512;
const audioQualityCache = new Map<string, AudioQuality>();

async function readAudioQualityFromStorageKey(key: string): Promise<AudioQuality> {
  const cached = audioQualityCache.get(key);
  if (cached) {
    audioQualityCache.delete(key);
    audioQualityCache.set(key, cached);
    return cached;
  }
  let result: AudioQuality;
  try {
    const absolutePath = await getObjectAbsolutePath(key);
    const metadata = await parseFile(absolutePath, {
      duration: false,
      skipCovers: true,
    });
    const bits = metadata.format.bitsPerSample;
    const sampleRate = metadata.format.sampleRate;
    result = {
      audioBitDepth:
        typeof bits === "number" && Number.isFinite(bits) ? Math.round(bits) : null,
      audioSampleRate:
        typeof sampleRate === "number" && Number.isFinite(sampleRate)
          ? Math.round(sampleRate)
          : null,
    };
  } catch {
    result = { audioBitDepth: null, audioSampleRate: null };
  }
  audioQualityCache.set(key, result);
  if (audioQualityCache.size > AUDIO_QUALITY_CACHE_LIMIT) {
    const oldestKey = audioQualityCache.keys().next().value;
    if (oldestKey !== undefined) audioQualityCache.delete(oldestKey);
  }
  return result;
}

function extensionForStoredFile(
  fieldName: "image" | "audio",
  contentType: string,
  fallbackName: string,
): string {
  const enforced = ensureAllowedExtension(fieldName, fallbackName, contentType);
  const ext = extname(enforced).toLowerCase();
  if (ext) {
    return ext;
  }
  return inferExtFromContentType(fieldName, contentType);
}

function inferExtFromContentType(
  fieldName: "image" | "audio",
  contentType: string,
): string {
  if (fieldName === "image") {
    if (contentType === "image/jpeg") return ".jpg";
    if (contentType === "image/png") return ".png";
    if (contentType === "image/gif") return ".gif";
    if (contentType === "image/webp") return ".webp";
    return ".jpg";
  }
  if (contentType === "audio/flac") return ".flac";
  if (
    contentType === "audio/aac" ||
    contentType === "audio/mp4" ||
    contentType === "audio/m4a" ||
    contentType === "audio/x-m4a"
  ) return ".m4a";
  if (contentType === "audio/mpeg") return ".mp3";
  if (contentType === "audio/wav") return ".wav";
  return ".mp3";
}

function ensureAllowedExtension(
  fieldName: "image" | "audio",
  fileName: string,
  contentType: string,
): string {
  const ext = extname(fileName).toLowerCase();
  const allowed =
    fieldName === "image"
      ? IMAGE_EXT_TYPES.has(ext)
      : AUDIO_EXT_TYPES.has(ext);
  if (allowed) return fileName;
  return `${fileName}${inferExtFromContentType(fieldName, contentType)}`;
}

function parseRemoteUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UploadError("Invalid URL", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UploadError("Only http(s) URLs are allowed", 400);
  }
  return parsed;
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
  if (trackIndex < 0 || !parts[trackIndex + 1]) {
    return null;
  }

  const trackId = parts[trackIndex + 1];
  if (!/^[A-Za-z0-9]{22}$/.test(trackId)) {
    return null;
  }

  return trackId;
}

function tryParsePlatformIdFromEntity(
  entityUniqueId: string,
  prefix: string,
): string | null {
  if (!entityUniqueId.startsWith(prefix)) {
    return null;
  }
  const value = entityUniqueId.slice(prefix.length).trim();
  return value || null;
}

function tryParseTrackIdFromUrl(url: string): string | null {
  const match = url.match(/\/track\/([A-Za-z0-9]+)/i);
  return match?.[1] ?? null;
}

function decodeBase64Loose(value: string): string | null {
  try {
    const normalized = value
      .trim()
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function extractTidalStreamFromManifest(manifestValue: string): string | null {
  const decoded = decodeBase64Loose(manifestValue);
  if (!decoded) {
    return null;
  }
  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const urls = parsed.urls;
    if (Array.isArray(urls)) {
      const first = urls.find((entry) => typeof entry === "string");
      return typeof first === "string" && first.startsWith("http") ? first : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
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
      throw new UploadError("Remote file fetch timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveUploadConfig(
  fieldName: "image" | "audio",
  mimeType: string,
  fileName: string,
): { contentType: string; maxBytes: number; prefix: string } | null {
  const ext = extname(fileName).toLowerCase();
  if (fieldName === "image") {
    const extType = IMAGE_EXT_TYPES.get(ext);
    const lower = mimeType.toLowerCase();
    if (IMAGE_MIME_TYPES.has(lower)) {
      return {
        contentType: lower,
        maxBytes: MAX_IMAGE_BYTES,
        prefix: "images",
      };
    }
    if (extType) {
      return {
        contentType: extType,
        maxBytes: MAX_IMAGE_BYTES,
        prefix: "images",
      };
    }
    return null;
  }
  const lower = mimeType.toLowerCase();
  if (AUDIO_MIME_TYPES.has(lower)) {
    const normalized =
      lower === "audio/mp3"
        ? "audio/mpeg"
        : lower === "audio/x-flac"
          ? "audio/flac"
        : lower === "audio/x-wav" || lower === "audio/wave"
          ? "audio/wav"
          : lower;
    return {
      contentType: normalized,
      maxBytes: MAX_AUDIO_BYTES,
      prefix: "audio",
    };
  }
  const extType = AUDIO_EXT_TYPES.get(ext);
  if (extType) {
    return { contentType: extType, maxBytes: MAX_AUDIO_BYTES, prefix: "audio" };
  }
  return null;
}

function createByteLimiter(maxBytes: number, label: string) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new UploadError(`${label} exceeds ${formatBytes(maxBytes)}`, 413),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

async function uploadStreamWithLimit(
  file: NodeJS.ReadableStream,
  key: string,
  contentType: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const limiter = createByteLimiter(maxBytes, label);
  const pass = new PassThrough();
  const upload = putObjectFromStream(key, pass, contentType);
  await Promise.all([upload, pipeline(file, limiter, pass)]);
}

async function uploadFromRemoteUrl(
  fieldName: "image" | "audio",
  rawUrl: string,
  options?: {
    fallbackContentType?: string;
    fileNameHint?: string;
    basePath?: string;
  },
): Promise<UploadedFile> {
  const parsedUrl = parseRemoteUrl(rawUrl);
  const response = await fetchWithTimeout(
    parsedUrl.toString(),
    REMOTE_FETCH_TIMEOUT_MS,
  ).catch((error) => {
    if (error instanceof UploadError) {
      throw error;
    }
    throw new UploadError("Failed to fetch remote file", 502);
  });

  if (!response.ok) {
    throw new UploadError(
      `Remote server returned ${response.status}`,
      response.status >= 500 ? 502 : 400,
    );
  }
  if (!response.body) {
    throw new UploadError("Remote response has no body", 400);
  }

  const responseTypeHeader = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const responseType = responseTypeHeader || options?.fallbackContentType || "";

  const fallbackName = options?.fileNameHint || (fieldName === "image" ? "cover" : "audio");
  const pathBaseName = decodeURIComponent(basename(parsedUrl.pathname || ""));
  const remoteName = sanitizeFileName(pathBaseName || fallbackName);
  const uploadConfig = resolveUploadConfig(fieldName, responseType, remoteName);
  if (!uploadConfig) {
    throw new UploadError(
      fieldName === "image"
        ? "Unsupported remote image type"
        : "Unsupported remote audio type",
      415,
    );
  }

  const normalizedName = ensureAllowedExtension(
    fieldName,
    remoteName,
    uploadConfig.contentType,
  );
  const fileId = randomUUID();
  const remoteExt = extname(normalizedName).toLowerCase() || inferExtFromContentType(fieldName, uploadConfig.contentType);
  const fileName = `${fileId}${remoteExt}`;
  const key = options?.basePath
    ? join(
        options.basePath,
        fieldName === "audio" ? "audio" : "cover",
        fileName,
      ).replaceAll("\\", "/")
    : join(uploadConfig.prefix, fileName).replaceAll("\\", "/");
  const nodeStream = Readable.fromWeb(response.body as unknown as WebReadableStream);
  const label = fieldName === "image" ? "Image file" : "Audio file";

  await uploadStreamWithLimit(
    nodeStream,
    key,
    uploadConfig.contentType,
    uploadConfig.maxBytes,
    label,
  );

  return { fileName, key, contentType: uploadConfig.contentType };
}

async function uploadFromAmazonMusicSource(
  source: AmazonMusicSource,
  options?: {
    basePath?: string;
  },
): Promise<UploadedFile> {
  const audio = await openAmazonMusicSource(source).catch((error) => {
    if (error instanceof AmazonMusicDownloadError) {
      throw new UploadError(error.message, error.status);
    }
    throw new UploadError("Failed to prepare Amazon Music audio", 502);
  });

  try {
    const remoteName = sanitizeFileName(audio.fileNameHint || source.fileNameHint);
    const uploadConfig = resolveUploadConfig("audio", audio.contentType, remoteName);
    if (!uploadConfig) {
      throw new UploadError("Unsupported Amazon Music audio type", 415);
    }

    const normalizedName = ensureAllowedExtension(
      "audio",
      remoteName,
      uploadConfig.contentType,
    );
    const fileId = randomUUID();
    const remoteExt =
      extname(normalizedName).toLowerCase() ||
      inferExtFromContentType("audio", uploadConfig.contentType);
    const fileName = `${fileId}${remoteExt}`;
    const key = options?.basePath
      ? join(options.basePath, "audio", fileName).replaceAll("\\", "/")
      : join(uploadConfig.prefix, fileName).replaceAll("\\", "/");

    await uploadStreamWithLimit(
      audio.stream,
      key,
      uploadConfig.contentType,
      uploadConfig.maxBytes,
      "Audio file",
    );

    return { fileName, key, contentType: uploadConfig.contentType };
  } finally {
    await audio.cleanup();
  }
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
): Promise<ResolvedSpotifyAudioDownload> {
  const amazonPlatform = getPlatformLink(songLinkPayload, "amazonMusic");
  const amazonUrl = normalizeAmazonMusicUrl(amazonPlatform?.url ?? "");
  if (!amazonUrl) {
    throw new UploadError("No Amazon Music mapping found for this Spotify track", 400);
  }
  const amazonSource = await resolveAmazonMusicSource(amazonUrl).catch((error) => {
    if (error instanceof AmazonMusicDownloadError) {
      throw new UploadError(error.message, error.status);
    }
    throw new UploadError("Failed to resolve Amazon Music stream", 502);
  });
  return { service: "amazon", amazonSource };
}

function getSongLinkMetadata(
  songLinkPayload: Record<string, unknown>,
  spotifyTrackId: string,
): { title: string; artist: string; thumbnailUrl: string } {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (!entities) {
    return { title: "", artist: "", thumbnailUrl: "" };
  }

  const candidates = [
    toStringValue(songLinkPayload.entityUniqueId),
    `SPOTIFY_SONG::${spotifyTrackId}`,
  ];
  for (const key of candidates) {
    if (!key) continue;
    const entity = toObject(entities[key]);
    if (!entity) continue;
    return {
      title: toStringValue(entity.title),
      artist: toStringValue(entity.artistName),
      thumbnailUrl: toStringValue(entity.thumbnailUrl),
    };
  }

  for (const value of Object.values(entities)) {
    const entity = toObject(value);
    if (!entity) continue;
    const title = toStringValue(entity.title);
    const artist = toStringValue(entity.artistName);
    if (!title && !artist) continue;
    return {
      title,
      artist,
      thumbnailUrl: toStringValue(entity.thumbnailUrl),
    };
  }

  return { title: "", artist: "", thumbnailUrl: "" };
}

async function fetchSongLinkPayload(
  spotifyTrackId: string,
  region: string,
): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${spotifyTrackId}`;
  const params = new URLSearchParams({
    url: spotifyUrl,
  });
  if (region) {
    params.set("userCountry", region);
  }
  const apiUrl = `https://api.song.link/v1-alpha.1/links?${params.toString()}`;
  const response = await fetchWithTimeout(apiUrl, REMOTE_FETCH_TIMEOUT_MS).catch(() => {
    throw new UploadError("Failed to reach song.link", 502);
  });
  if (!response.ok) {
    throw new UploadError(`song.link returned ${response.status}`, 502);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new UploadError("song.link returned invalid JSON", 502);
  }
  const payload = toObject(data);
  if (!payload) {
    throw new UploadError("song.link response is invalid", 502);
  }
  return payload;
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
): Promise<string> {
  const tidalPlatform = getPlatformLink(songLinkPayload, "tidal");
  if (!tidalPlatform) {
    throw new UploadError("No Tidal mapping found for this Spotify track", 400);
  }

  const entityTrackId = tryParsePlatformIdFromEntity(
    tidalPlatform.entityUniqueId,
    "TIDAL_SONG::",
  );
  const urlTrackId = tidalPlatform.url ? tryParseTrackIdFromUrl(tidalPlatform.url) : null;
  const tidalTrackId = entityTrackId || urlTrackId;
  if (!tidalTrackId || !/^\d+$/.test(tidalTrackId)) {
    throw new UploadError("Could not resolve Tidal track ID", 400);
  }

  const requestedQuality = quality || "LOSSLESS";
  let lastError: string | null = null;

  for (const apiBase of TIDAL_API_BASES) {
    const apiUrl = `${apiBase}/track/?id=${tidalTrackId}&quality=${encodeURIComponent(requestedQuality)}`;
    try {
      const response = await fetchWithTimeout(apiUrl, REMOTE_FETCH_TIMEOUT_MS);
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
          if (!row) continue;
          const directUrl = toStringValue(row.OriginalTrackUrl);
          if (directUrl.startsWith("http")) {
            return directUrl;
          }
        }
      }

      const objectPayload = toObject(parsed);
      if (!objectPayload) {
        lastError = `${apiBase} response shape is unsupported`;
        continue;
      }

      const directUrl = toStringValue(objectPayload.OriginalTrackUrl);
      if (directUrl.startsWith("http")) {
        return directUrl;
      }

      const data = toObject(objectPayload.data);
      const manifest = data ? toStringValue(data.manifest || data.Manifest) : "";
      const manifestUrl = manifest ? extractTidalStreamFromManifest(manifest) : null;
      if (manifestUrl) {
        return manifestUrl;
      }

      lastError = `${apiBase} had no stream URL`;
    } catch (error) {
      if (error instanceof UploadError) {
        lastError = error.message;
      } else {
        lastError = `${apiBase} request failed`;
      }
    }
  }

  throw new UploadError(
    lastError
      ? `Failed to resolve Tidal stream (${lastError})`
      : "Failed to resolve Tidal stream",
    502,
  );
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

  const deezerResponse = await fetchWithTimeout(
    `https://api.deezer.com/track/${deezerTrackId}`,
    REMOTE_FETCH_TIMEOUT_MS,
  ).catch(() => null);
  if (!deezerResponse?.ok) {
    return "";
  }
  const deezerPayload = toObject(await deezerResponse.json().catch(() => null));
  return toStringValue(deezerPayload?.isrc).toUpperCase();
}

async function resolveQobuzDownload(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  options: {
    title: string;
    artist: string;
    album: string;
  },
): Promise<ResolvedSpotifyAudioDownload> {
  const isrc = await resolveDeezerIsrc(songLinkPayload);
  if (!isrc && !options.title && !options.artist) {
    throw new UploadError("Qobuz needs an ISRC or title/artist metadata", 400);
  }

  try {
    return {
      service: "qobuz",
      streamUrl: await resolveQobuzProviderStreamUrl({
        isrc,
        title: options.title,
        artist: options.artist,
        album: options.album,
        quality: quality || "6",
      }),
    };
  } catch (error) {
    if (error instanceof QobuzDownloadError) {
      throw new UploadError(error.message, error.status);
    }
    throw new UploadError("Failed to resolve Qobuz stream", 502);
  }
}

async function parseLinkSongPayload(payload: LinkSongPayload): Promise<{
  data?: LinkSongData;
  error?: UploadFailure;
}> {
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const audioUrl = toStringValue(payload.audioUrl);
  const imageUrl = toStringValue(payload.imageUrl);
  const lyricsText = toStringValue(payload.lyricsText);

  if (!title || !artist || !audioUrl) {
    return {
      error: {
        status: 400,
        message: "Missing fields: title, artist, and audioUrl are required",
      },
    };
  }

  try {
    const basePath = buildOrganizedMusicBasePath(title, artist);
    const audio = await uploadFromRemoteUrl("audio", audioUrl, { basePath });
    const audioQuality = await readAudioQualityFromStorageKey(audio.key);
    const image = imageUrl
      ? await uploadFromRemoteUrl("image", imageUrl, { basePath })
      : null;
    return {
      data: {
        title,
        artist,
        image,
        audio,
        lyricsText,
        audioBitDepth: audioQuality.audioBitDepth,
        audioSampleRate: audioQuality.audioSampleRate,
      },
    };
  } catch (error) {
    if (error instanceof UploadError) {
      return { error: { status: error.status, message: error.message } };
    }
    return { error: { status: 500, message: "Failed to import linked media" } };
  }
}

async function parseSpotifySongRequest(payload: LinkSongPayload): Promise<{
  data?: LinkSongData;
  error?: UploadFailure;
}> {
  const spotifyInput = toStringValue(payload.spotifyUrl);
  const trackId = parseSpotifyTrackId(spotifyInput);
  if (!trackId) {
    return { error: { status: 400, message: "Invalid Spotify track URL or ID" } };
  }

  const service = toStringValue(payload.service).toLowerCase();
  const qualityRaw = toStringValue(payload.quality);
  const qualityProfileRaw = toStringValue(payload.qualityProfile).toLowerCase();
  const region = toStringValue(payload.region).toUpperCase();
  const lyricsText = toStringValue(payload.lyricsText);
  const quality = qualityRaw;

  const qualityProfile = ["cd", "hires48", "max"].includes(qualityProfileRaw)
    ? qualityProfileRaw
    : "max";

  const profileQobuzQualities =
    qualityProfile === "cd"
      ? ["6"]
      : qualityProfile === "hires48"
        ? ["7", "6"]
        : ["27", "7", "6"];
  const profileTidalQualities =
    qualityProfile === "cd"
      ? ["LOSSLESS", "HIGH"]
      : qualityProfile === "hires48"
        ? ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH"]
        : ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH"];

  try {
    const songLinkPayload = await fetchSongLinkPayload(trackId, region).catch(() => ({}));
    const metadata = getSongLinkMetadata(songLinkPayload, trackId);
    const title = toStringValue(payload.title) || metadata.title || `Track ${trackId}`;
    const artist = toStringValue(payload.artist) || metadata.artist || "Unknown Artist";
    const album = toStringValue(payload.album);
    const basePath = buildOrganizedMusicBasePath(title, artist);

    let audioDownload: ResolvedSpotifyAudioDownload | null = null;

    if (service === "tidal") {
      const tidalQualities = quality ? [quality] : profileTidalQualities;
      const tidalErrors: string[] = [];
      for (const q of tidalQualities) {
        try {
          audioDownload = {
            service: "tidal",
            streamUrl: await resolveTidalStreamUrl(songLinkPayload, q),
          };
          break;
        } catch (error) {
          tidalErrors.push(error instanceof Error ? error.message : `quality ${q} failed`);
        }
      }
      if (!audioDownload) {
        throw new UploadError(
          `No Tidal stream found for requested quality profile: ${tidalErrors.join(" | ")}`,
          502,
        );
      }
    } else if (service === "qobuz") {
      const qobuzQualities = quality ? [quality] : profileQobuzQualities;
      const qobuzErrors: string[] = [];
      for (const q of qobuzQualities) {
        try {
          audioDownload = await resolveQobuzDownload(songLinkPayload, q, {
            title,
            artist,
            album,
          });
          break;
        } catch (error) {
          qobuzErrors.push(error instanceof Error ? error.message : `quality ${q} failed`);
        }
      }
      if (!audioDownload) {
        throw new UploadError(
          `No Qobuz stream found for requested quality profile: ${qobuzErrors.join(" | ")}`,
          502,
        );
      }
    } else if (service === "amazon") {
      audioDownload = await resolveAmazonDownload(songLinkPayload);
    } else if (service) {
      throw new UploadError('Unsupported service. Use "tidal", "qobuz", or "amazon".', 400);
    } else {
      const qobuzQualities = quality ? [quality] : profileQobuzQualities;
      const qobuzErrors: string[] = [];
      for (const q of qobuzQualities) {
        try {
          audioDownload = await resolveQobuzDownload(songLinkPayload, q, {
            title,
            artist,
            album,
          });
          break;
        } catch (error) {
          qobuzErrors.push(error instanceof Error ? error.message : `quality ${q} failed`);
        }
      }

      if (!audioDownload) {
        const amazonErrors: string[] = [];
        try {
          audioDownload = await resolveAmazonDownload(songLinkPayload);
        } catch (error) {
          amazonErrors.push(error instanceof Error ? error.message : "Amazon Music failed");
        }

        if (!audioDownload) {
          const tidalQualities = quality ? [quality] : profileTidalQualities;
          const tidalErrors: string[] = [];
          for (const q of tidalQualities) {
            try {
              audioDownload = {
                service: "tidal",
                streamUrl: await resolveTidalStreamUrl(songLinkPayload, q),
              };
              break;
            } catch (error) {
              tidalErrors.push(error instanceof Error ? error.message : `quality ${q} failed`);
            }
          }

          if (!audioDownload) {
            throw new UploadError(
              `No downloadable provider found. Qobuz: ${qobuzErrors.join(" | ")}. Amazon: ${amazonErrors.join(" | ")}. Tidal: ${tidalErrors.join(" | ")}`,
              502,
            );
          }
        }
      }
    }

    if (!audioDownload) {
      throw new UploadError("No downloadable provider found", 502);
    }

    const audio =
      audioDownload.service === "amazon"
        ? await uploadFromAmazonMusicSource(audioDownload.amazonSource, { basePath })
        : await uploadFromRemoteUrl("audio", audioDownload.streamUrl, {
            fallbackContentType: "audio/flac",
            fileNameHint: `${trackId}.flac`,
            basePath,
          });
    const audioQuality = await readAudioQualityFromStorageKey(audio.key);

    let image: UploadedFile | null = null;
    if (metadata.thumbnailUrl) {
      try {
        image = await uploadFromRemoteUrl("image", metadata.thumbnailUrl, {
          fileNameHint: `${trackId}.jpg`,
          basePath,
        });
      } catch {
        image = null;
      }
    }

    return {
      data: {
        title,
        artist,
        image,
        audio,
        lyricsText,
        audioBitDepth: audioQuality.audioBitDepth,
        audioSampleRate: audioQuality.audioSampleRate,
      },
    };
  } catch (error) {
    if (error instanceof UploadError) {
      return { error: { status: error.status, message: error.message } };
    }
    return { error: { status: 500, message: "Failed to import Spotify link" } };
  }
}

async function parseMultipartUpload(req: Request): Promise<{
  data?: {
    title: string;
    artist: string;
    image: UploadedFile;
    audio: UploadedFile;
    audioBitDepth: number | null;
    audioSampleRate: number | null;
  };
  error?: UploadFailure;
}> {
  const contentTypeHeader = req.headers.get("content-type") || "";
  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    return { error: { status: 400, message: "Expected multipart/form-data" } };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { error: { status: 400, message: "Invalid multipart upload" } };
  }

  const title = toStringValue(form.get("title"));
  const artist = toStringValue(form.get("artist"));
  const imageInput = form.get("image");
  const audioInput = form.get("audio");

  if (!title || !artist || !(imageInput instanceof File) || !(audioInput instanceof File)) {
    return { error: { status: 400, message: "Missing fields" } };
  }

  const basePath = buildOrganizedMusicBasePath(title, artist);

  const imageOriginalName = sanitizeFileName(imageInput.name || "cover");
  const imageConfig = resolveUploadConfig("image", imageInput.type || "", imageOriginalName);
  if (!imageConfig) {
    return { error: { status: 415, message: "Unsupported image type" } };
  }
  if (imageInput.size > imageConfig.maxBytes) {
    return { error: { status: 413, message: `Image file exceeds ${formatBytes(imageConfig.maxBytes)}` } };
  }

  const audioOriginalName = sanitizeFileName(audioInput.name || "audio");
  const audioConfig = resolveUploadConfig("audio", audioInput.type || "", audioOriginalName);
  if (!audioConfig) {
    return { error: { status: 415, message: "Unsupported audio type" } };
  }
  if (audioInput.size > audioConfig.maxBytes) {
    return { error: { status: 413, message: `Audio file exceeds ${formatBytes(audioConfig.maxBytes)}` } };
  }

  try {
    const imageExt = extensionForStoredFile("image", imageConfig.contentType, imageOriginalName);
    const imageFileName = `${randomUUID()}${imageExt}`;
    const imageKey = join(basePath, "cover", imageFileName).replaceAll("\\", "/");
    // Stream file parts directly to storage rather than buffering the whole
    // file in memory (a single concurrent 50 MB audio upload otherwise pins
    // ~50 MB of RSS per request).
    await uploadStreamWithLimit(
      Readable.fromWeb(imageInput.stream() as unknown as WebReadableStream),
      imageKey,
      imageConfig.contentType,
      imageConfig.maxBytes,
      "Image file",
    );

    const audioExt = extensionForStoredFile("audio", audioConfig.contentType, audioOriginalName);
    const audioFileName = `${randomUUID()}${audioExt}`;
    const audioKey = join(basePath, "audio", audioFileName).replaceAll("\\", "/");
    await uploadStreamWithLimit(
      Readable.fromWeb(audioInput.stream() as unknown as WebReadableStream),
      audioKey,
      audioConfig.contentType,
      audioConfig.maxBytes,
      "Audio file",
    );
    const audioQuality = await readAudioQualityFromStorageKey(audioKey);

    return {
      data: {
        title,
        artist,
        image: {
          fileName: imageFileName,
          key: imageKey,
          contentType: imageConfig.contentType,
        },
        audio: {
          fileName: audioFileName,
          key: audioKey,
          contentType: audioConfig.contentType,
        },
        audioBitDepth: audioQuality.audioBitDepth,
        audioSampleRate: audioQuality.audioSampleRate,
      },
    };
  } catch (error) {
    if (error instanceof UploadError) {
      return { error: { status: error.status, message: error.message } };
    }
    return { error: { status: 500, message: "Upload failed" } };
  }
}

export async function GET() {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();
  const songs = await db<SongRow>`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    ORDER BY "title" ASC
    LIMIT 5000
  `;

  // Backfill missing quality metadata opportunistically, but keep request latency bounded.
  const BACKFILL_PER_REQUEST = 6;
  const pendingBackfill = songs
    .filter(
      (song) =>
        typeof song.audioBitDepth !== "number" || typeof song.audioSampleRate !== "number",
    )
    .slice(0, BACKFILL_PER_REQUEST);
  await Promise.all(
    pendingBackfill.map(async (song) => {
      const key = parseStorageKeyFromApiUrl(song.audioUrl || "");
      if (!key) return;
      const quality = await readAudioQualityFromStorageKey(key);
      if (quality.audioBitDepth == null && quality.audioSampleRate == null) {
        return;
      }
      song.audioBitDepth = quality.audioBitDepth;
      song.audioSampleRate = quality.audioSampleRate;
      await db`
        UPDATE "Song"
        SET "audioBitDepth" = ${quality.audioBitDepth},
            "audioSampleRate" = ${quality.audioSampleRate}
        WHERE "id" = ${song.id}
      `;
    }),
  );

  return NextResponse.json(songs);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  type AppSession = Session & {
    user: NonNullable<Session["user"]> & { id: string };
  };
  const s = session as AppSession | null;
  if (!s?.user?.email || !s.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contentType = req.headers.get("content-type") || "";
  let title = "";
  let artist = "";
  let imageUrl = "/waveform.svg";
  let audioUrl = "";
  let lyricsText = "";
  let audioBitDepth: number | null = null;
  let audioSampleRate: number | null = null;
  let replaceExisting = false;

  if (contentType.toLowerCase().startsWith("application/json")) {
    let payload: LinkSongPayload;
    try {
      payload = (await req.json()) as LinkSongPayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const mode = toStringValue(payload.mode).toLowerCase();
    replaceExisting =
      payload.replaceExisting === true ||
      toStringValue(payload.replaceExisting).toLowerCase() === "true";
    const parsed =
      mode === "spotify" || toStringValue(payload.spotifyUrl)
        ? await parseSpotifySongRequest(payload)
        : await parseLinkSongPayload(payload);
    if (parsed.error) {
      return NextResponse.json(
        { error: parsed.error.message },
        { status: parsed.error.status },
      );
    }

    const linkData = parsed.data!;
    title = linkData.title;
    artist = linkData.artist;
    audioUrl = toApiFileUrl(linkData.audio.key);
    imageUrl = linkData.image
      ? toApiFileUrl(linkData.image.key)
      : "/waveform.svg";
    lyricsText = linkData.lyricsText?.trim() || "";
    audioBitDepth = linkData.audioBitDepth;
    audioSampleRate = linkData.audioSampleRate;
  } else {
    const parsed = await parseMultipartUpload(req);
    if (parsed.error) {
      return NextResponse.json(
        { error: parsed.error.message },
        { status: parsed.error.status },
      );
    }

    const uploadData = parsed.data!;
    title = uploadData.title;
    artist = uploadData.artist;
    imageUrl = toApiFileUrl(uploadData.image.key);
    audioUrl = toApiFileUrl(uploadData.audio.key);
    audioBitDepth = uploadData.audioBitDepth;
    audioSampleRate = uploadData.audioSampleRate;
  }

  const userId = s.user.id;
  const duplicateRows = await db<{ id: string; title: string; artist: string }>`
    SELECT "id", "title", "artist"
    FROM "Song"
    WHERE "userId" = ${userId}
      AND lower("title") = lower(${title})
      AND lower("artist") = lower(${artist})
    LIMIT 1
  `;
  const existingSong = duplicateRows[0] ?? null;

  if (existingSong && !replaceExisting) {
    return NextResponse.json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong,
      },
      { status: 409 },
    );
  }

  const songId = existingSong?.id ?? randomUUID();
  let lyricsUrl: string | null = null;

  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();
  if (lyricsText) {
    const lyricsBuffer = Buffer.from(lyricsText, "utf8");
    if (lyricsBuffer.byteLength > MAX_LYRICS_BYTES) {
      return NextResponse.json({ error: "Lyrics text is too large" }, { status: 413 });
    }
    const lyricsBasePath = buildOrganizedMusicBasePath(title, artist);
    const lyricsKey = `${lyricsBasePath}/lyrics/${songId}-${randomUUID()}.lrc`;
    await putObjectFromBuffer(lyricsKey, lyricsBuffer, "text/plain; charset=utf-8");
    lyricsUrl = toApiFileUrl(lyricsKey);
  }
  const [song] = existingSong
    ? await db<SongRow>`
        UPDATE "Song"
        SET "title" = ${title},
            "artist" = ${artist},
            "imageUrl" = ${imageUrl},
            "audioUrl" = ${audioUrl},
            "lyricsUrl" = ${lyricsUrl},
            "audioBitDepth" = ${audioBitDepth},
            "audioSampleRate" = ${audioSampleRate}
        WHERE "id" = ${songId}
        RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `
    : await db<SongRow>`
        INSERT INTO "Song" ("id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId")
        VALUES (${songId}, ${title}, ${artist}, ${imageUrl}, ${audioUrl}, ${lyricsUrl}, ${audioBitDepth}, ${audioSampleRate}, ${userId})
        RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `;

  return NextResponse.json(song, { status: existingSong ? 200 : 201 });
}
