import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { compare, hash } from "bcryptjs";
import { basename, extname, join } from "node:path";
import { D1_SCHEMA_STATEMENTS } from "@/lib/db-schema";
import type { PlaylistRow, SongRow, UserRow } from "@/lib/db-types";
import { buildSql, statementReturnsRows, type SqlRow, type SqlTag, type TemplateValue } from "@/lib/sql-tag";
import { songToPlayerSong } from "@/lib/song-utils";
import { inferContentTypeFromKey, normalizeStorageKey } from "@/lib/storage-keys";
import {
  QobuzDownloadError,
  resolveQobuzAvailability,
  resolveQobuzStreamUrl as resolveQobuzProviderStreamUrl,
} from "@/lib/qobuz-download";
import {
  TidalDownloadError,
  resolveTidalStreamUrl as resolveTidalProviderStreamUrl,
} from "@/lib/tidal-download";
import {
  SpotifyPathfinderError,
  fetchSpotifyAlbumTracks as fetchPathfinderAlbumTracks,
  fetchSpotifyLikedTracks,
  fetchSpotifyPlaylistTracks as fetchPathfinderPlaylistTracks,
  scrapeSpotifyTrackIdsFromHtml,
} from "@/lib/spotify-pathfinder";

type Variables = {
  user: AuthUser | null;
  db: SqlTag;
};

type AppEnv = {
  Bindings: CloudflareEnv;
  Variables: Variables;
};

type MusicProxyEnv = CloudflareEnv & {
  MAC_MINI_ORIGIN?: string;
  MAC_MINI_PROXY_TOKEN?: string;
};

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type ActionPayload = {
  action?: unknown;
  spotifyUrl?: unknown;
  region?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  batchType?: unknown;
  outputFormat?: unknown;
};

type BatchDownloadPayload = {
  spotifyUrl?: unknown;
  region?: unknown;
  qualityProfile?: unknown;
  service?: unknown;
  outputFormat?: unknown;
  includeMetadata?: unknown;
  includeLyrics?: unknown;
  includeCover?: unknown;
  spotifyCookie?: unknown;
};

type SongPayload = {
  mode?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  duration?: unknown;
  durationMs?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  spotifyUrl?: unknown;
  service?: unknown;
  quality?: unknown;
  qualityProfile?: unknown;
  outputFormat?: unknown;
  region?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
};

type ResolvedAudioDownload = {
  service: "qobuz" | "tidal";
  streamUrl: string;
};

type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

type EnhancedMetadata = {
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  releaseDate?: string;
  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;
  genre?: string;
  isrc?: string;
  upc?: string;
  composer?: string;
  publisher?: string;
  copyright?: string;
  lyrics?: string;
  duration?: number;
  bitDepth?: number;
  sampleRate?: number;
};

const SESSION_COOKIE = "spotify_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;
const SPOTIFY_REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 120_000;
const SERVER_IMPORT_OUTPUT_FORMAT: OutputFormat = "flac";
const OUTPUT_FORMATS = new Set<OutputFormat>(["flac", "mp3", "aac", "ogg", "opus", "wav"]);

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

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
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

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitStore = new Map<string, RateLimitEntry>();
let schemaPromise: Promise<void> | null = null;
let songColumnsPromise: Promise<void> | null = null;

class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function createD1SqlTag(d1: D1Database): SqlTag {
  const tag = (async function d1Tag<T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]> {
    const { sql, params } = buildSql(strings, values);
    const statement = d1.prepare(sql).bind(...params);
    if (statementReturnsRows(sql)) {
      const result = await statement.all<T>();
      return result.results ?? [];
    }
    await statement.run();
    return [];
  }) as SqlTag;

  tag.end = async () => {};
  return tag;
}

async function ensureSchema(env: CloudflareEnv): Promise<void> {
  schemaPromise ??= (async () => {
    for (const statement of D1_SCHEMA_STATEMENTS) {
      await env.DB.prepare(statement).bind().run();
    }
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
}

async function ensureSongColumns(db: SqlTag): Promise<void> {
  songColumnsPromise ??= (async () => {
    for (const statement of [
      'ALTER TABLE "Song" ADD COLUMN "lyricsUrl" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "audioBitDepth" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "audioSampleRate" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "duration" REAL',
      'ALTER TABLE "Song" ADD COLUMN "album" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "albumArtist" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "releaseDate" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "trackNumber" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "totalTracks" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "discNumber" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "totalDiscs" INTEGER',
      'ALTER TABLE "Song" ADD COLUMN "genre" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "isrc" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "upc" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "composer" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "publisher" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "copyright" TEXT',
      'ALTER TABLE "Song" ADD COLUMN "outputFormat" TEXT DEFAULT "flac"',
    ]) {
      try {
        await db([statement] as unknown as TemplateStringsArray);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) {
          throw error;
        }
      }
    }
  })().catch((error) => {
    songColumnsPromise = null;
    throw error;
  });
  await songColumnsPromise;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function durationSecondsFromPayload(payload: SongPayload): number | null {
  const durationMs = toNumberValue(payload.durationMs);
  if (durationMs != null && durationMs > 0) {
    return Math.round(durationMs / 1000);
  }

  const duration = toNumberValue(payload.duration);
  if (duration != null && duration > 0) {
    return Math.round(duration > 1000 ? duration / 1000 : duration);
  }

  return null;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function outputFormatFromPayload(value: unknown): OutputFormat {
  const format = toStringValue(value).toLowerCase() as OutputFormat;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}

function assertServerImportOutputFormat(payload: Pick<SongPayload, "outputFormat">): void {
  const outputFormat = outputFormatFromPayload(payload.outputFormat);
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    throw new ApiError(
      `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      400,
    );
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSecureCookieRequest(urlString: string): boolean {
  const url = new URL(urlString);
  if (url.protocol === "https:") return true;
  return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValueParts.join("=") || "");
    }
  }
  return "";
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getRequestIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

function rateLimit(req: Request, keyPrefix: string, max: number, windowMs: number) {
  const ip = getRequestIp(req);
  const key = `${keyPrefix}:${ip}`;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
  entry.count += 1;
  rateLimitStore.set(key, entry);
  const allowed = entry.count <= max;
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(max));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
  headers.set("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
  if (!allowed) headers.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
  return { allowed, headers, ip };
}

async function getCurrentUser(req: Request, db: SqlTag): Promise<AuthUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const rows = await db<AuthUser>`
    SELECT u."id", u."email", u."name", u."image"
    FROM "Session" s
    INNER JOIN "User" u ON u."id" = s."userId"
    WHERE s."sessionToken" = ${tokenHash}
      AND datetime(s."expires") > datetime('now')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function publicUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
  };
}

function requireUser(user: AuthUser | null): AuthUser {
  if (!user) throw new ApiError("Unauthorized", 401);
  return user;
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
  const parts = key
    .split("/")
    .filter(Boolean)
    .map((part) => {
      let decoded = part;
      for (let i = 0; i < 2; i += 1) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      return decoded;
    });
  return `/api/files/${parts.join("/")}`;
}

function parseStorageKeyFromApiPath(pathname: string): string {
  const encoded = pathname.slice("/api/files/".length);
  return encoded
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

function extensionForStoredFile(kind: "image" | "audio", fileName: string, contentType: string): string {
  const ext = extname(sanitizeFileName(fileName)).toLowerCase();
  if (kind === "image") {
    if (IMAGE_EXT_TYPES.has(ext)) return ext === ".jpeg" ? ".jpg" : ext;
    const normalized = contentType.toLowerCase().split(";")[0]?.trim() || "";
    if (!IMAGE_MIME_TYPES.has(normalized)) throw new ApiError("Unsupported image format", 415);
    if (normalized === "image/png") return ".png";
    if (normalized === "image/gif") return ".gif";
    if (normalized === "image/webp") return ".webp";
    return ".jpg";
  }
  if (AUDIO_EXT_TYPES.has(ext)) return ext;
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() || "";
  if (!AUDIO_MIME_TYPES.has(normalized)) throw new ApiError("Unsupported audio format", 415);
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return ".m4a";
  return ".flac";
}

async function putBuffer(env: CloudflareEnv, key: string, buffer: ArrayBuffer | Uint8Array, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), buffer, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}

async function putStream(env: CloudflareEnv, key: string, stream: ReadableStream, contentType?: string) {
  await env.MEDIA.put(normalizeStorageKey(key), stream, {
    httpMetadata: { contentType: contentType || inferContentTypeFromKey(key) },
  });
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "spotify/1.0 (+https://spotify.erlinhoxha.workers.dev)",
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("Remote request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseSpotifyTrackId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
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

function parseSpotifyAlbumId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
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
  const albumIndex = parts.findIndex((part) => part === "album");
  const albumId = albumIndex >= 0 ? parts[albumIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(albumId) ? albumId : null;
}

function parseSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;
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
  const playlistIndex = parts.findIndex((part) => part === "playlist");
  const playlistId = playlistIndex >= 0 ? parts[playlistIndex + 1] : "";
  return /^[A-Za-z0-9]{22}$/.test(playlistId) ? playlistId : null;
}

function determineSpotifyUrlType(url: string): "track" | "album" | "playlist" | "collection" | null {
  try {
    const parsed = new URL(url.trim());
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.includes("track")) return "track";
    if (parts.includes("album")) return "album";
    if (parts.includes("playlist")) return "playlist";
    if (parts.includes("collection")) return "collection";
  } catch {}
  return null;
}

function parseTrackIdFromUrl(url: string): string | null {
  return url.match(/\/track\/([A-Za-z0-9]+)/i)?.[1] ?? null;
}

function parsePlatformId(entityUniqueId: string, prefix: string): string {
  return entityUniqueId.startsWith(prefix) ? entityUniqueId.slice(prefix.length).trim() : "";
}

async function fetchJsonObject(url: string, timeoutMs = SPOTIFY_REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, timeoutMs).catch(() => {
    throw new ApiError("Upstream request failed", 502);
  });
  if (!response.ok) throw new ApiError(`Upstream request returned ${response.status}`, 502);
  const payload = toObject(await response.json().catch(() => null));
  if (!payload) throw new ApiError("Invalid upstream JSON", 502);
  return payload;
}

async function fetchSongLinkPayload(trackId: string, region: string): Promise<Record<string, unknown>> {
  const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
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

function parseSongLinkMetadata(songLinkPayload: Record<string, unknown>, spotifyTrackId: string) {
  const entities = toObject(songLinkPayload.entitiesByUniqueId);
  if (!entities) return { title: "", artist: "", imageUrl: "" };
  const keys = [toStringValue(songLinkPayload.entityUniqueId), `SPOTIFY_SONG::${spotifyTrackId}`];
  for (const key of keys) {
    if (!key) continue;
    const entity = toObject(entities[key]);
    if (!entity) continue;
    return {
      title: toStringValue(entity.title),
      artist: toStringValue(entity.artistName),
      imageUrl: toStringValue(entity.thumbnailUrl),
    };
  }
  return { title: "", artist: "", imageUrl: "" };
}

function parseDeezerTrackId(songLinkPayload: Record<string, unknown>): string {
  const deezer = getPlatformLink(songLinkPayload, "deezer");
  const entityId = deezer ? parsePlatformId(deezer.entityUniqueId, "DEEZER_SONG::") : "";
  const urlId = deezer?.url ? parseTrackIdFromUrl(deezer.url) : "";
  const id = entityId || urlId || "";
  return /^\d+$/.test(id) ? id : "";
}

async function fetchDeezerTrackInfo(deezerTrackId: string) {
  if (!deezerTrackId) return null;
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerTrackId}`).catch(() => null);
  if (!deezerPayload) return null;
  const albumObj = toObject(deezerPayload.album);
  const artistObj = toObject(deezerPayload.artist);
  const durationRaw = deezerPayload.duration;
  const playsRaw = deezerPayload.rank;
  const durationSec =
    typeof durationRaw === "number" ? durationRaw : typeof durationRaw === "string" ? Number(durationRaw) : 0;
  const plays = typeof playsRaw === "number" ? playsRaw : typeof playsRaw === "string" ? Number(playsRaw) : 0;
  const genresObj = toObject(deezerPayload.genres);
  const genreItems = Array.isArray(genresObj?.data) ? genresObj.data : [];
  const firstGenre = toObject(genreItems[0]);

  return {
    album: toStringValue(albumObj?.title),
    albumArtist: toStringValue(artistObj?.name),
    releaseDate: toStringValue(deezerPayload.release_date),
    trackNumber: typeof deezerPayload.track_position === "number" ? deezerPayload.track_position : undefined,
    totalTracks: typeof albumObj?.nb_tracks === "number" ? albumObj.nb_tracks : undefined,
    discNumber: typeof deezerPayload.disk_number === "number" ? deezerPayload.disk_number : undefined,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    plays: Number.isFinite(plays) ? plays : 0,
    isrc: toStringValue(deezerPayload.isrc).toUpperCase(),
    upc: toStringValue(albumObj?.upc),
    genre: toStringValue(firstGenre?.name) || undefined,
  };
}

async function fetchEnhancedMetadata(trackId: string, songLinkPayload: Record<string, unknown>): Promise<EnhancedMetadata> {
  const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
  const deezerInfo = await fetchDeezerTrackInfo(parseDeezerTrackId(songLinkPayload));

  // Try to get additional metadata from MusicBrainz using ISRC
  let musicBrainzData = null;
  if (deezerInfo?.isrc) {
    try {
      const mbResponse = await fetchWithTimeout(
        `https://musicbrainz.org/ws/2/recording?query=isrc:${deezerInfo.isrc}&fmt=json`,
        SPOTIFY_REQUEST_TIMEOUT_MS
      );
      if (mbResponse.ok) {
        const mbPayload = await mbResponse.json();
        const recording = mbPayload?.recordings?.[0];
        if (recording) {
          musicBrainzData = {
            composer: recording.relations
              ?.filter((rel: any) => rel.type === "composer")
              ?.map((rel: any) => rel.artist?.name)
              ?.join(", ") || undefined,
            publisher: recording.relations
              ?.filter((rel: any) => rel.type === "publisher")
              ?.map((rel: any) => rel.label?.name)
              ?.join(", ") || undefined,
          };
        }
      }
    } catch {
      // MusicBrainz lookup failed, continue without composer/publisher data
    }
  }

  return {
    title: metadata.title || "Unknown Title",
    artist: metadata.artist || "Unknown Artist",
    album: deezerInfo?.album || "",
    albumArtist: deezerInfo?.albumArtist,
    releaseDate: deezerInfo?.releaseDate,
    trackNumber: deezerInfo?.trackNumber,
    totalTracks: deezerInfo?.totalTracks,
    discNumber: deezerInfo?.discNumber,
    genre: deezerInfo?.genre,
    isrc: deezerInfo?.isrc,
    upc: deezerInfo?.upc,
    composer: musicBrainzData?.composer,
    publisher: musicBrainzData?.publisher,
    duration: deezerInfo?.durationSec,
  };
}

async function getPreviewUrl(trackId: string): Promise<string> {
  const response = await fetchWithTimeout(`https://open.spotify.com/embed/track/${trackId}`, 20_000).catch(() => null);
  if (!response?.ok) return "";
  const html = await response.text().catch(() => "");
  return html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9?&=._-]+/)?.[0] ?? "";
}

async function fetchSpotifyAlbumTracks(albumId: string, spotifyCookie = ""): Promise<Array<{ id: string; name: string; artists: Array<{ name: string }> }>> {
  try {
    const result = await fetchPathfinderAlbumTracks(albumId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artists: track.artists.map((name) => ({ name })),
    }));
  } catch {
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/album/${albumId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        id,
        name: "Unknown Track",
        artists: [{ name: "Unknown Artist" }],
      }));
    } catch {
      return [];
    }
  }
}

async function fetchSpotifyPlaylistTracks(playlistId: string, spotifyCookie = ""): Promise<Array<{ track: { id: string; name: string; artists: Array<{ name: string }> } }>> {
  try {
    const result = await fetchPathfinderPlaylistTracks(playlistId, spotifyCookie || undefined);
    return result.tracks.map((track) => ({
      track: {
        id: track.id,
        name: track.name,
        artists: track.artists.map((name) => ({ name })),
      },
    }));
  } catch (error) {
    if (error instanceof SpotifyPathfinderError && error.status !== 502) throw error;
    try {
      const response = await fetchWithTimeout(`https://open.spotify.com/playlist/${playlistId}`, SPOTIFY_REQUEST_TIMEOUT_MS);
      if (!response.ok) return [];
      const html = await response.text();
      return scrapeSpotifyTrackIdsFromHtml(html).map((id) => ({
        track: { id, name: "Unknown Track", artists: [{ name: "Unknown Artist" }] },
      }));
    } catch {
      return [];
    }
  }
}

function extractLrcFromSpotifyLyricsApi(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  const obj = toObject(payload);
  if (!obj) return "";
  const direct = toStringValue(obj.lyrics || obj.lrc || obj.syncedLyrics);
  if (direct) return direct;
  const linesValue = obj.lines;
  if (!Array.isArray(linesValue)) return "";
  const lines: string[] = [];
  for (const item of linesValue) {
    const line = toObject(item);
    if (!line) continue;
    const words = toStringValue(line.words || line.text);
    if (!words) continue;
    const timeTag = toStringValue(line.timeTag || line.startTimeMs || line.time);
    lines.push(timeTag ? `[${timeTag}]${words}` : words);
  }
  return lines.join("\n").trim();
}

async function fetchLyricsText(trackId: string, title: string, artist: string): Promise<string> {
  const spotifyLyricsUrl = `https://spotify-lyrics-api-pi.vercel.app/?trackid=${encodeURIComponent(trackId)}&format=lrc`;
  const spotifyLyricsRes = await fetchWithTimeout(spotifyLyricsUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (spotifyLyricsRes?.ok) {
    const payload = await spotifyLyricsRes.json().catch(() => null);
    const obj = toObject(payload);
    if (!obj?.error) {
      const lrc = extractLrcFromSpotifyLyricsApi(payload);
      if (lrc) return lrc;
    }
  }
  const lrclibUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
  const lrclibRes = await fetchWithTimeout(lrclibUrl, SPOTIFY_REQUEST_TIMEOUT_MS).catch(() => null);
  if (lrclibRes?.ok) {
    const payload = toObject(await lrclibRes.json().catch(() => null));
    return toStringValue(payload?.syncedLyrics) || toStringValue(payload?.plainLyrics);
  }
  return "";
}

async function resolveDeezerIsrc(songLinkPayload: Record<string, unknown>): Promise<string> {
  const deezerId = parseDeezerTrackId(songLinkPayload);
  if (!deezerId) return "";
  const deezerPayload = await fetchJsonObject(`https://api.deezer.com/track/${deezerId}`).catch(() => null);
  return toStringValue(deezerPayload?.isrc).toUpperCase();
}

function qualityLists(payload: SongPayload) {
  const qualityRaw = toStringValue(payload.quality);
  const profileRaw = toStringValue(payload.qualityProfile).toLowerCase();
  const qualityProfile = ["cd", "hires48", "max"].includes(profileRaw) ? profileRaw : "max";
  const qobuz = qualityProfile === "cd" ? ["6"] : qualityProfile === "hires48" ? ["7", "6"] : ["27", "7", "6"];
  const tidal =
    qualityProfile === "cd"
      ? ["LOSSLESS"]
      : qualityProfile === "hires48"
        ? ["HI_RES_LOSSLESS", "LOSSLESS"]
        : ["HI_RES_LOSSLESS", "LOSSLESS"];
  return {
    qobuz: qualityRaw ? [qualityRaw] : qobuz,
    tidal: qualityRaw ? [qualityRaw] : tidal,
  };
}

async function resolveTidalStreamUrl(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<string> {
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const entityTrackId = tidal ? parsePlatformId(tidal.entityUniqueId, "TIDAL_SONG::") : "";
  const urlTrackId = tidal?.url ? parseTrackIdFromUrl(tidal.url) : "";
  try {
    return await resolveTidalProviderStreamUrl({
      tidalTrackId: entityTrackId || urlTrackId || "",
      title: toStringValue(payload.title),
      artist: toStringValue(payload.artist),
      album: toStringValue(payload.album),
      quality: quality || "LOSSLESS",
    });
  } catch (error) {
    if (error instanceof TidalDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Tidal stream", 502);
  }
}

async function resolveQobuzDownload(
  songLinkPayload: Record<string, unknown>,
  quality: string,
  payload: SongPayload,
): Promise<ResolvedAudioDownload> {
  const isrc = await resolveDeezerIsrc(songLinkPayload);
  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  const album = toStringValue(payload.album);
  if (!isrc && !title && !artist) throw new ApiError("Qobuz needs an ISRC or title/artist metadata", 400);
  try {
    return {
      service: "qobuz",
      streamUrl: await resolveQobuzProviderStreamUrl({ isrc, title, artist, album, quality: quality || "6" }),
    };
  } catch (error) {
    if (error instanceof QobuzDownloadError) throw new ApiError(error.message, error.status);
    throw new ApiError("Failed to resolve Qobuz stream", 502);
  }
}

async function resolveStreamUrl(payload: SongPayload): Promise<ResolvedAudioDownload> {
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) throw new ApiError("Invalid Spotify track URL or ID", 400);
  const songLinkPayload = await fetchSongLinkPayload(trackId, toStringValue(payload.region).toUpperCase()).catch(() => ({}));
  const service = toStringValue(payload.service).toLowerCase();
  const qualities = qualityLists(payload);

  if (service === "tidal") {
    const errors: string[] = [];
    for (const quality of qualities.tidal) {
      try {
        return { service: "tidal", streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload) };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
      }
    }
    throw new ApiError(`No Tidal stream found: ${errors.join(" | ")}`, 502);
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
    throw new ApiError(`No Qobuz stream found: ${errors.join(" | ")}`, 502);
  }
  if (service) throw new ApiError('Unsupported service. Use "tidal" or "qobuz".', 400);

  const qobuzErrors: string[] = [];
  for (const quality of qualities.qobuz) {
    try {
      return await resolveQobuzDownload(songLinkPayload, quality, payload);
    } catch (error) {
      qobuzErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }
  const tidalErrors: string[] = [];
  for (const quality of qualities.tidal) {
    try {
      return { service: "tidal", streamUrl: await resolveTidalStreamUrl(songLinkPayload, quality, payload) };
    } catch (error) {
      tidalErrors.push(error instanceof Error ? error.message : `quality ${quality} failed`);
    }
  }
  throw new ApiError(
    `No downloadable provider found. Qobuz: ${qobuzErrors.join(" | ")}. Tidal: ${tidalErrors.join(" | ")}`,
    502,
  );
}

function extensionFromResponse(response: Response, streamUrl: string): string {
  try {
    const urlExt = extname(new URL(streamUrl).pathname).toLowerCase();
    if (urlExt) return urlExt;
  } catch {}
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  return ".flac";
}

async function uploadRemoteCover(env: CloudflareEnv, title: string, artist: string, imageUrl: string): Promise<string> {
  if (!imageUrl) return "/apple-icon.png";
  const parsed = parseHttpUrl(imageUrl);
  if (!parsed) return "/apple-icon.png";
  const response = await fetchWithTimeout(parsed.toString(), SPOTIFY_REQUEST_TIMEOUT_MS);
  if (!response.ok) return "/apple-icon.png";
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
  if (!IMAGE_MIME_TYPES.has(contentType)) return "/apple-icon.png";
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return "/apple-icon.png";
  const ext = contentType === "image/png" ? ".png" : contentType === "image/gif" ? ".gif" : contentType === "image/webp" ? ".webp" : ".jpg";
  const key = `${buildOrganizedMusicBasePath(title, artist)}/cover/${crypto.randomUUID()}${ext}`;
  await putBuffer(env, key, buffer, contentType);
  return toApiFileUrl(key);
}

async function storeLyrics(env: CloudflareEnv, title: string, artist: string, songId: string, lyricsText: string): Promise<string | null> {
  const text = lyricsText.trim();
  if (!text) return null;
  const buffer = new TextEncoder().encode(text);
  if (buffer.byteLength > MAX_LYRICS_BYTES) throw new ApiError("Lyrics text is too large", 413);
  const key = `${buildOrganizedMusicBasePath(title, artist)}/lyrics/${songId}-${crypto.randomUUID()}.lrc`;
  await putBuffer(env, key, buffer, "text/plain; charset=utf-8");
  return toApiFileUrl(key);
}

async function readJson<T>(req: Request): Promise<T | null> {
  return (await req.json().catch(() => null)) as T | null;
}

async function listPlaylists(db: SqlTag, userId: string | null) {
  if (!userId) return [];
  const rows = await db<PlaylistRow & { songsCount: number }>`
    SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", COUNT(ps."id") AS "songsCount"
    FROM "Playlist" p
    LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
    WHERE p."userId" = ${userId}
    GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt"
    ORDER BY p."createdAt" DESC
  `;
  return rows.map((row) => ({ ...row, songsCount: Number(row.songsCount ?? 0) }));
}

async function listSongs(db: SqlTag) {
  await ensureSongColumns(db);
  return db<SongRow>`
    SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    ORDER BY "title" ASC
    LIMIT 5000
  `;
}

function parseRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=") || size <= 0) return null;
  const rangeValue = rangeHeader.slice("bytes=".length).trim();
  if (!rangeValue || rangeValue.includes(",")) return null;
  const dashIndex = rangeValue.indexOf("-");
  if (dashIndex === -1) return null;
  const startStr = rangeValue.slice(0, dashIndex);
  const endStr = rangeValue.slice(dashIndex + 1);
  if (!startStr) {
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  let end = endStr ? Number(endStr) : size - 1;
  if (!Number.isFinite(end) || end < 0) return null;
  if (end >= size) end = size - 1;
  if (end < start) return null;
  return { start, end };
}

function getMacMiniOrigin(env: CloudflareEnv): string {
  const origin = ((env as MusicProxyEnv).MAC_MINI_ORIGIN || "").trim();
  return origin.replace(/\/+$/, "");
}

function getMacMiniProxyToken(env: CloudflareEnv): string {
  return ((env as MusicProxyEnv).MAC_MINI_PROXY_TOKEN || "").trim();
}

function isMacMiniMusicConfigured(env: CloudflareEnv): boolean {
  const origin = getMacMiniOrigin(env);
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function shouldProxyMusicRequest(c: Context<AppEnv>): boolean {
  if (!isMacMiniMusicConfigured(c.env)) return false;
  const pathname = new URL(c.req.url).pathname;
  const method = c.req.method.toUpperCase();

  if (pathname.startsWith("/api/songs/spotify")) return false;
  if (pathname.startsWith("/api/files/local/")) return true;
  if (pathname.startsWith("/api/artwork/local/")) return true;
  if (pathname.startsWith("/api/songs/")) return true;
  if (["/api/music/source", "/api/home", "/api/library", "/api/liked", "/api/likes"].includes(pathname)) {
    return true;
  }
  if (pathname === "/api/songs") {
    if (method === "GET") return true;
    if (method !== "POST") return false;
    const contentType = c.req.header("content-type") || "";
    return !contentType.toLowerCase().startsWith("application/json");
  }
  return false;
}

function macMiniProxyHeaders(c: Context<AppEnv>): Headers {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cookie");
  headers.delete("authorization");
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  return headers;
}

async function proxyToMacMini(c: Context<AppEnv>): Promise<Response> {
  const sourceUrl = new URL(c.req.url);
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, getMacMiniOrigin(c.env));
  const method = c.req.method.toUpperCase();
  return fetch(targetUrl.toString(), {
    method,
    headers: macMiniProxyHeaders(c),
    body: method === "GET" || method === "HEAD" ? undefined : c.req.raw.body,
    redirect: "manual",
  });
}

async function authorizeMacMiniMutation(c: Context<AppEnv>): Promise<Response | null> {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  await ensureSchema(c.env);
  const db = createD1SqlTag(c.env.DB);
  const user = await getCurrentUser(c.req.raw, db);
  if (!user) return jsonError("Unauthorized", 401);
  return null;
}

async function postJsonToMacMini(c: Context<AppEnv>, payload: Record<string, unknown>): Promise<Response> {
  const targetUrl = new URL("/api/songs", getMacMiniOrigin(c.env));
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  const token = getMacMiniProxyToken(c.env);
  if (token) headers.set("x-spotify-proxy-token", token);
  return fetch(targetUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  if (shouldProxyMusicRequest(c)) {
    const unauthorized = await authorizeMacMiniMutation(c);
    if (unauthorized) return unauthorized;
    return proxyToMacMini(c);
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  await ensureSchema(c.env);
  const db = createD1SqlTag(c.env.DB);
  c.set("db", db);
  c.set("user", await getCurrentUser(c.req.raw, db));
  await next();
});

app.get("/api/auth/session", (c) => {
  const user = c.get("user");
  return c.json({ user: user ? publicUser(user) : null });
});

app.post("/api/auth/signin", async (c) => {
  const limited = rateLimit(c.req.raw, "auth", 20, 5 * 60 * 1000);
  if (!limited.allowed) return c.json({ error: "Too many requests" }, { status: 429, headers: limited.headers });
  const body = await readJson<{ email?: unknown; password?: unknown }>(c.req.raw);
  const email = toStringValue(body?.email).toLowerCase();
  const password = toStringValue(body?.password);
  if (!email || !password) return jsonError("Email and password are required", 400);
  const db = c.get("db");
  const users = await db<UserRow>`
    SELECT "id", "email", "name", "image", "passwordHash"
    FROM "User"
    WHERE "email" = ${email}
    LIMIT 1
  `;
  const user = users[0];
  if (!user?.passwordHash || !(await compare(password, user.passwordHash))) {
    return jsonError("Invalid email or password", 401);
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await db`
    INSERT INTO "Session" ("id", "sessionToken", "userId", "expires")
    VALUES (${crypto.randomUUID()}, ${tokenHash}, ${user.id}, ${expires})
  `;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureCookieRequest(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires,
  });
  return c.json({ user: publicUser(user) });
});

app.post("/api/auth/signout", async (c) => {
  const token = readCookie(c.req.raw, SESSION_COOKIE);
  if (token) {
    await c.get("db")`
      DELETE FROM "Session"
      WHERE "sessionToken" = ${await sha256Hex(token)}
    `;
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return new Response(null, { status: 204 });
});

app.post("/api/register", async (c) => {
  const limited = rateLimit(c.req.raw, "register", 5, 10 * 60 * 1000);
  if (!limited.allowed) return c.json({ error: "Too many requests" }, { status: 429, headers: limited.headers });
  const body = await readJson<{ name?: unknown; email?: unknown; password?: unknown }>(c.req.raw);
  const email = toStringValue(body?.email).toLowerCase();
  const password = toStringValue(body?.password);
  const name = toStringValue(body?.name);
  if (!email || !password) return jsonError("Email and password are required", 400);
  if (password.length < 8 || password.length > 128) return jsonError("Password must be 8-128 characters", 400);
  const db = c.get("db");
  const existing = await db<UserRow>`
    SELECT "id"
    FROM "User"
    WHERE "email" = ${email}
    LIMIT 1
  `;
  if (existing[0]) return jsonError("Email already in use", 409);
  await db`
    INSERT INTO "User" ("id", "email", "name", "passwordHash", "image", "emailVerified", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${email}, ${name || null}, ${await hash(password, 10)}, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  return c.json({ ok: true }, 201);
});

app.get("/api/home", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const [songs, likes] = await Promise.all([
    listSongs(db),
    user
      ? db<{ songId: string }>`SELECT "songId" FROM "Like" WHERE "userId" = ${user.id}`
      : Promise.resolve([] as Array<{ songId: string }>),
  ]);
  return c.json({ songs: songs.map(songToPlayerSong), likedSongIds: likes.map((like) => like.songId) });
});

app.get("/api/library", async (c) => {
  const user = c.get("user");
  return c.json({ playlists: await listPlaylists(c.get("db"), user?.id ?? null), userId: user?.id ?? null });
});

app.get("/api/liked", async (c) => {
  const user = requireUser(c.get("user"));
  await ensureSongColumns(c.get("db"));
  const rows = await c.get("db")<SongRow & { songId: string }>`
    SELECT s."id", s."title", s."artist", s."album", s."duration", s."imageUrl", s."audioUrl", s."lyricsUrl", s."audioBitDepth", s."audioSampleRate", s."userId", s."createdAt", l."songId"
    FROM "Like" l
    INNER JOIN "Song" s ON s."id" = l."songId"
    WHERE l."userId" = ${user.id}
    ORDER BY l."createdAt" DESC
  `;
  return c.json({ songs: rows.map(songToPlayerSong), likedSongIds: rows.map((row) => row.songId) });
});

app.get("/api/playlist/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  if (!user) return jsonError("Unauthorized", 401);
  const id = c.req.param("id");
  await ensureSongColumns(db);
  const playlists = await db<PlaylistRow>`
    SELECT "id", "name", "imageUrl", "userId", "createdAt"
    FROM "Playlist"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  const playlist = playlists[0];
  if (!playlist) return jsonError("Playlist not found", 404);
  if (playlist.userId !== user.id) return jsonError("Forbidden", 403);
  const songRows = await db<SongRow & { order: number; likedSongId: string | null }>`
    SELECT s."id", s."title", s."artist", s."album", s."duration", s."imageUrl", s."audioUrl", s."lyricsUrl", s."audioBitDepth", s."audioSampleRate", s."userId", s."createdAt", ps."order", l."songId" AS "likedSongId"
    FROM "PlaylistSong" ps
    INNER JOIN "Song" s ON s."id" = ps."songId"
    LEFT JOIN "Like" l ON l."songId" = s."id" AND l."userId" = ${user.id}
    WHERE ps."playlistId" = ${id}
    ORDER BY ps."order" ASC
  `;
  return c.json({
    playlist,
    songs: songRows.map(songToPlayerSong),
    likedSongIds: user ? songRows.filter((row) => !!row.likedSongId).map((row) => row.id) : [],
  });
});

app.get("/api/songs/spotify/cover", async (c) => {
  requireUser(c.get("user"));
  const remoteUrlRaw = c.req.query("url") || "";
  const fileName = sanitizeFileName(c.req.query("filename") || "cover");
  const remoteUrl = parseHttpUrl(remoteUrlRaw);
  if (!remoteUrl) return jsonError("Only valid http(s) URLs are allowed", 400);
  const upstream = await fetchWithTimeout(remoteUrl.toString(), SPOTIFY_REQUEST_TIMEOUT_MS);
  if (!upstream.ok) throw new ApiError(`Upstream cover request returned ${upstream.status}`, 502);
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      "content-disposition": `attachment; filename="${fileName.replaceAll('"', "'")}"`,
      "cache-control": "no-store",
    },
  });
});

app.post("/api/songs/spotify/file", async (c) => {
  requireUser(c.get("user"));
  const payload = await readJson<SongPayload>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);
  const resolved = await resolveStreamUrl(payload);
  const response = await fetchWithTimeout(resolved.streamUrl, DOWNLOAD_REQUEST_TIMEOUT_MS);
  if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
  const ext = extensionFromResponse(response, resolved.streamUrl);
  const title = sanitizeFileName(toStringValue(payload.title) || "Track");
  const artist = sanitizeFileName(toStringValue(payload.artist) || "Unknown Artist");
  const headers = new Headers();
  headers.set("content-type", response.headers.get("content-type") || "audio/flac");
  headers.set("content-disposition", `attachment; filename="${`${artist} - ${title}${ext}`.replaceAll('"', "'")}"`);
  const length = response.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(response.body, { headers });
});

app.post("/api/songs/spotify/batch", async (c) => {
  requireUser(c.get("user"));
  const payload = await readJson<BatchDownloadPayload>(c.req.raw);
  if (!payload) return jsonError("Invalid JSON body", 400);

  const spotifyUrl = toStringValue(payload.spotifyUrl);
  const urlType = determineSpotifyUrlType(spotifyUrl);

  if (!urlType) {
    return jsonError("Invalid Spotify URL. Must be a track, album, playlist, or Liked Songs URL.", 400);
  }

  const region = toStringValue(payload.region).toUpperCase() || "US";
  const outputFormat = toStringValue(payload.outputFormat).toLowerCase() as OutputFormat;
  const format = ["flac", "mp3", "aac", "ogg", "opus", "wav"].includes(outputFormat) ? outputFormat : "flac";
  const spotifyCookie = toStringValue(payload.spotifyCookie);

  let trackIds: string[] = [];
  let batchTitle = "";
  let batchArtist = "";

  try {
    if (urlType === "track") {
      const trackId = parseSpotifyTrackId(spotifyUrl);
      if (!trackId) return jsonError("Invalid track ID", 400);
      trackIds = [trackId];
      const songLinkPayload = await fetchSongLinkPayload(trackId, region);
      const metadata = await fetchEnhancedMetadata(trackId, songLinkPayload);
      batchTitle = metadata.title;
      batchArtist = metadata.artist;
    } else if (urlType === "album") {
      const albumId = parseSpotifyAlbumId(spotifyUrl);
      if (!albumId) return jsonError("Invalid album ID", 400);
      const albumResult = await fetchPathfinderAlbumTracks(albumId, spotifyCookie || undefined).catch(async () => {
        const albumTracks = await fetchSpotifyAlbumTracks(albumId, spotifyCookie);
        return {
          title: albumTracks[0]?.name || "Unknown Album",
          artist: albumTracks[0]?.artists[0]?.name || "Unknown Artist",
          tracks: albumTracks.map((track) => ({
            id: track.id,
            name: track.name,
            artists: track.artists.map((artist) => artist.name),
          })),
        };
      });
      trackIds = albumResult.tracks.map((track) => track.id);
      batchTitle = albumResult.title;
      batchArtist = albumResult.artist;
    } else if (urlType === "playlist") {
      const playlistId = parseSpotifyPlaylistId(spotifyUrl);
      if (!playlistId) return jsonError("Invalid playlist ID", 400);
      const playlistResult = await fetchPathfinderPlaylistTracks(playlistId, spotifyCookie || undefined).catch(async () => {
        const playlistTracks = await fetchSpotifyPlaylistTracks(playlistId, spotifyCookie);
        return {
          title: "Playlist",
          tracks: playlistTracks.map((item) => ({
            id: item.track.id,
            name: item.track.name,
            artists: item.track.artists.map((artist) => artist.name),
          })),
        };
      });
      trackIds = playlistResult.tracks.map((track) => track.id);
      batchTitle = playlistResult.title;
      batchArtist = "Various Artists";
    } else if (urlType === "collection") {
      if (!spotifyCookie) {
        return jsonError(
          "Liked Songs import requires a Spotify sp_dc cookie.",
          400,
        );
      }
      const likedResult = await fetchSpotifyLikedTracks(spotifyCookie);
      trackIds = likedResult.tracks.map((track) => track.id);
      batchTitle = likedResult.title;
      batchArtist = "Various Artists";
    }

    if (trackIds.length === 0) {
      return jsonError("No tracks found", 404);
    }

    trackIds = Array.from(new Set(trackIds));

    if (trackIds.length > 10_000) {
      return jsonError("Maximum 10,000 tracks per batch", 400);
    }

    return c.json({
      batchInfo: {
        type: urlType === "collection" ? "playlist" : urlType,
        title: batchTitle,
        artist: batchArtist,
        trackCount: trackIds.length,
        format,
        trackIds,
      },
      message: `Found ${trackIds.length} tracks. Click Download All to start.`,
    });

  } catch (error) {
    if (error instanceof SpotifyPathfinderError) {
      return jsonError(error.message, error.status);
    }
    return jsonError(error instanceof Error ? error.message : "Failed to process batch", 500);
  }
});

app.post("/api/songs/spotify", async (c) => {
  requireUser(c.get("user"));
  const payloadRaw = await readJson<ActionPayload>(c.req.raw);
  const payload = toObject(payloadRaw) as ActionPayload | null;
  if (!payload) return jsonError("Invalid JSON body", 400);
  const action = toStringValue(payload.action).toLowerCase();
  const trackId = parseSpotifyTrackId(toStringValue(payload.spotifyUrl));
  if (!trackId) return jsonError("Invalid Spotify track URL or ID", 400);

  const songLinkPayload = await fetchSongLinkPayload(trackId, toStringValue(payload.region).toUpperCase());
  const metadata = parseSongLinkMetadata(songLinkPayload, trackId);
  const deezerInfo = await fetchDeezerTrackInfo(parseDeezerTrackId(songLinkPayload));

  if (action === "availability") {
    const qobuz = await resolveQobuzAvailability({
      isrc: deezerInfo?.isrc || "",
      title: toStringValue(payload.title) || metadata.title,
      artist: toStringValue(payload.artist) || metadata.artist,
      album: toStringValue(payload.album) || deezerInfo?.album || "",
    });
    const tidal = getPlatformLink(songLinkPayload, "tidal");
    return c.json({
      availability: {
        tidal: Boolean(tidal?.url),
        qobuz: qobuz.available,
        tidalUrl: tidal?.url || "",
        qobuzUrl: qobuz.qobuzUrl,
      },
    });
  }

  if (action === "lyrics") {
    const title = toStringValue(payload.title) || metadata.title;
    const artist = toStringValue(payload.artist) || metadata.artist;
    if (!title || !artist) return jsonError("Missing title/artist for lyrics lookup", 400);
    const lyrics = await fetchLyricsText(trackId, title, artist);
    if (!lyrics) return jsonError("Lyrics not found for this track", 404);
    return c.json({ lyrics, fileName: `${title} - ${artist}.lrc`.replace(/[\\/:*?"<>|]/g, "_") });
  }

  if (action !== "fetch") {
    return jsonError('Invalid action. Use "fetch", "availability", or "lyrics".', 400);
  }

  const qobuz = await resolveQobuzAvailability({
    isrc: deezerInfo?.isrc || "",
    title: toStringValue(payload.title) || metadata.title,
    artist: toStringValue(payload.artist) || metadata.artist,
    album: toStringValue(payload.album) || deezerInfo?.album || "",
  });
  const tidal = getPlatformLink(songLinkPayload, "tidal");
  const previewUrl = await getPreviewUrl(trackId);
  return c.json({
    track: {
      spotifyId: trackId,
      title: metadata.title || "Unknown Title",
      artist: metadata.artist || "Unknown Artist",
      album: deezerInfo?.album || "",
      releaseDate: deezerInfo?.releaseDate || "",
      totalPlays: deezerInfo?.plays || 0,
      durationMs: (deezerInfo?.durationSec || 0) * 1000,
      imageUrl: metadata.imageUrl || "",
      previewUrl,
    },
    availability: {
      tidal: Boolean(tidal?.url),
      qobuz: qobuz.available,
      tidalUrl: tidal?.url || "",
      qobuzUrl: qobuz.qobuzUrl,
    },
  });
});

app.get("/api/songs", async (c) => c.json(await listSongs(c.get("db"))));

app.post("/api/songs", async (c) => {
  const user = requireUser(c.get("user"));
  const db = c.get("db");
  await ensureSongColumns(db);
  const contentType = c.req.header("content-type") || "";
  let title = "";
  let artist = "";
  let album = "";
  let duration: number | null = null;
  let imageUrl = "/apple-icon.png";
  let audioUrl = "";
  let lyricsText = "";
  const audioBitDepth: number | null = null;
  const audioSampleRate: number | null = null;
  let replaceExisting = false;

  if (contentType.toLowerCase().startsWith("application/json")) {
    const payload = await readJson<SongPayload>(c.req.raw);
    if (!payload) return jsonError("Invalid JSON body", 400);
    replaceExisting = payload.replaceExisting === true || toStringValue(payload.replaceExisting).toLowerCase() === "true";
    assertServerImportOutputFormat(payload);
    title = toStringValue(payload.title);
    artist = toStringValue(payload.artist);
    album = toStringValue(payload.album);
    duration = durationSecondsFromPayload(payload);
    if (!title || !artist) return jsonError("Title and artist are required", 400);

    if (isMacMiniMusicConfigured(c.env)) {
      const isSpotifyImport = toStringValue(payload.mode).toLowerCase() === "spotify" || Boolean(toStringValue(payload.spotifyUrl));
      const remoteAudioUrl = toStringValue(payload.audioUrl);
      const resolvedAudioUrl = isSpotifyImport ? (await resolveStreamUrl(payload)).streamUrl : remoteAudioUrl;
      if (!resolvedAudioUrl) return jsonError("Audio URL is required", 400);
      return postJsonToMacMini(c, {
        title,
        artist,
        album,
        durationMs: toNumberValue(payload.durationMs) ?? (duration ? duration * 1000 : undefined),
        imageUrl: toStringValue(payload.imageUrl),
        audioUrl: resolvedAudioUrl,
        lyricsText: toStringValue(payload.lyricsText),
        replaceExisting,
      });
    }

    const duplicateRows = await db<{ id: string; title: string; artist: string }>`
      SELECT "id", "title", "artist"
      FROM "Song"
      WHERE "userId" = ${user.id}
        AND lower("title") = lower(${title})
        AND lower("artist") = lower(${artist})
      LIMIT 1
    `;
    if (duplicateRows[0] && !replaceExisting) {
      return c.json(
        { error: "Song already exists in your library", code: "DUPLICATE_SONG", existingSong: duplicateRows[0] },
        409,
      );
    }

    if (toStringValue(payload.mode).toLowerCase() === "spotify" || toStringValue(payload.spotifyUrl)) {
      const resolved = await resolveStreamUrl(payload);
      const response = await fetchWithTimeout(resolved.streamUrl, DOWNLOAD_REQUEST_TIMEOUT_MS);
      if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
      const responseType = response.headers.get("content-type") || "audio/flac";
      const ext = extensionFromResponse(response, resolved.streamUrl);
      const audioKey = `${buildOrganizedMusicBasePath(title, artist)}/audio/${crypto.randomUUID()}${ext}`;
      await putStream(c.env, audioKey, response.body, responseType);
      audioUrl = toApiFileUrl(audioKey);
      imageUrl = await uploadRemoteCover(c.env, title, artist, toStringValue(payload.imageUrl));
      lyricsText = toStringValue(payload.lyricsText);
    } else {
      const remoteAudioUrl = toStringValue(payload.audioUrl);
      const remoteAudio = parseHttpUrl(remoteAudioUrl);
      if (!remoteAudio) return jsonError("Only valid http(s) audio URLs are allowed", 400);
      const response = await fetchWithTimeout(remoteAudio.toString(), DOWNLOAD_REQUEST_TIMEOUT_MS);
      if (!response.ok || !response.body) throw new ApiError(`Audio server returned ${response.status}`, 502);
      const responseType = response.headers.get("content-type") || "audio/flac";
      const ext = extensionFromResponse(response, remoteAudio.toString());
      const audioKey = `${buildOrganizedMusicBasePath(title, artist)}/audio/${crypto.randomUUID()}${ext}`;
      await putStream(c.env, audioKey, response.body, responseType);
      audioUrl = toApiFileUrl(audioKey);
      imageUrl = await uploadRemoteCover(c.env, title, artist, toStringValue(payload.imageUrl));
      lyricsText = toStringValue(payload.lyricsText);
    }
  } else {
    const form = await c.req.formData();
    title = toStringValue(form.get("title"));
    artist = toStringValue(form.get("artist"));
    const image = form.get("image");
    const audio = form.get("audio");
    if (!title || !artist || !(image instanceof File) || !(audio instanceof File)) {
      return jsonError("Title, artist, image, and audio are required", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image file is too large", 413);
    if (audio.size > MAX_AUDIO_BYTES) return jsonError("Audio file is too large", 413);
    const basePath = buildOrganizedMusicBasePath(title, artist);
    const imageExt = extensionForStoredFile("image", image.name, image.type);
    const audioExt = extensionForStoredFile("audio", audio.name, audio.type);
    const imageKey = `${basePath}/cover/${crypto.randomUUID()}${imageExt}`;
    const audioKey = `${basePath}/audio/${crypto.randomUUID()}${audioExt}`;
    await putBuffer(c.env, imageKey, await image.arrayBuffer(), image.type || inferContentTypeFromKey(imageKey));
    await putBuffer(c.env, audioKey, await audio.arrayBuffer(), audio.type || inferContentTypeFromKey(audioKey));
    imageUrl = toApiFileUrl(imageKey);
    audioUrl = toApiFileUrl(audioKey);
  }

  const existingRows = await db<{ id: string; title: string; artist: string }>`
    SELECT "id", "title", "artist"
    FROM "Song"
    WHERE "userId" = ${user.id}
      AND lower("title") = lower(${title})
      AND lower("artist") = lower(${artist})
    LIMIT 1
  `;
  const existingSong = existingRows[0] ?? null;
  if (existingSong && !replaceExisting) {
    return c.json(
      { error: "Song already exists in your library", code: "DUPLICATE_SONG", existingSong },
      409,
    );
  }

  const songId = existingSong?.id ?? crypto.randomUUID();
  const lyricsUrl = await storeLyrics(c.env, title, artist, songId, lyricsText);
  const rows = existingSong
    ? await db<SongRow>`
        UPDATE "Song"
        SET "title" = ${title}, "artist" = ${artist}, "album" = ${album || null}, "duration" = ${duration}, "imageUrl" = ${imageUrl}, "audioUrl" = ${audioUrl}, "lyricsUrl" = ${lyricsUrl}, "audioBitDepth" = ${audioBitDepth}, "audioSampleRate" = ${audioSampleRate}
        WHERE "id" = ${songId}
        RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `
    : await db<SongRow>`
        INSERT INTO "Song" ("id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId")
        VALUES (${songId}, ${title}, ${artist}, ${album || null}, ${duration}, ${imageUrl}, ${audioUrl}, ${lyricsUrl}, ${audioBitDepth}, ${audioSampleRate}, ${user.id})
        RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      `;
  return c.json(rows[0], existingSong ? 200 : 201);
});

app.get("/api/songs/:id", async (c) => {
  await ensureSongColumns(c.get("db"));
  const rows = await c.get("db")<SongRow>`
    SELECT "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    WHERE "id" = ${c.req.param("id")}
    LIMIT 1
  `;
  if (!rows[0]) return jsonError("Song not found", 404);
  return c.json(songToPlayerSong(rows[0]));
});

app.patch("/api/songs/:id", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ title?: unknown; artist?: unknown }>(c.req.raw);
  const title = toStringValue(payload?.title);
  const artist = toStringValue(payload?.artist);
  if (!title || !artist) return jsonError("Title and artist are required", 400);
  const db = c.get("db");
  const existing = await db<{ id: string; userId: string }>`
    SELECT "id", "userId" FROM "Song" WHERE "id" = ${c.req.param("id")} LIMIT 1
  `;
  if (!existing[0]) return jsonError("Song not found", 404);
  if (existing[0].userId !== user.id) return jsonError("Forbidden", 403);
  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "title" = ${title}, "artist" = ${artist}
    WHERE "id" = ${c.req.param("id")}
    RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;
  return c.json(songToPlayerSong(rows[0]));
});

app.post("/api/songs/:id/assets", async (c) => {
  const user = requireUser(c.get("user"));
  const db = c.get("db");
  const songs = await db<{ id: string; title: string; artist: string; imageUrl: string; lyricsUrl: string | null; userId: string }>`
    SELECT "id", "title", "artist", "imageUrl", "lyricsUrl", "userId"
    FROM "Song"
    WHERE "id" = ${c.req.param("id")}
    LIMIT 1
  `;
  const song = songs[0];
  if (!song) return jsonError("Song not found", 404);
  if (song.userId !== user.id) return jsonError("Forbidden", 403);
  const form = await c.req.formData();
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsText = toStringValue(form.get("lyricsText"));
  let imageUrl = song.imageUrl;
  let lyricsUrl = song.lyricsUrl;
  const basePath = buildOrganizedMusicBasePath(song.title, song.artist);
  if (image instanceof File && image.size > 0) {
    if (image.size > MAX_IMAGE_BYTES) return jsonError("Image exceeds max upload size", 413);
    const imageExt = extensionForStoredFile("image", image.name, image.type);
    const imageKey = `${basePath}/cover/${song.id}-${crypto.randomUUID()}${imageExt}`;
    await putBuffer(c.env, imageKey, await image.arrayBuffer(), image.type || inferContentTypeFromKey(imageKey));
    imageUrl = toApiFileUrl(imageKey);
  }
  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    if (lyricsFile.size > MAX_LYRICS_BYTES) return jsonError("Lyrics file is too large", 413);
    const text = await lyricsFile.text();
    lyricsUrl = await storeLyrics(c.env, song.title, song.artist, song.id, text);
  } else if (lyricsText) {
    lyricsUrl = await storeLyrics(c.env, song.title, song.artist, song.id, lyricsText);
  }
  if (imageUrl === song.imageUrl && lyricsUrl === song.lyricsUrl) {
    return jsonError("Provide an image, lyrics file, or lyrics text", 400);
  }
  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "imageUrl" = ${imageUrl}, "lyricsUrl" = ${lyricsUrl}
    WHERE "id" = ${song.id}
    RETURNING "id", "title", "artist", "album", "duration", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;
  return c.json(songToPlayerSong(rows[0]));
});

app.get("/api/likes", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ likes: [] });
  const likes = await c.get("db")<{ songId: string }>`
    SELECT "songId"
    FROM "Like"
    WHERE "userId" = ${user.id}
  `;
  return c.json({ likes: likes.map((like) => like.songId) });
});

app.post("/api/likes", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ songId?: unknown }>(c.req.raw);
  const songId = toStringValue(payload?.songId);
  if (!songId) return jsonError("Missing songId", 400);
  const song = await c.get("db")<{ id: string }>`SELECT "id" FROM "Song" WHERE "id" = ${songId} LIMIT 1`;
  if (!song[0]) return jsonError("Song not found", 404);
  await c.get("db")`
    INSERT INTO "Like" ("id", "userId", "songId", "createdAt")
    VALUES (${crypto.randomUUID()}, ${user.id}, ${songId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "songId") DO NOTHING
  `;
  return c.json({ ok: true });
});

app.delete("/api/likes", async (c) => {
  const user = requireUser(c.get("user"));
  const payload = await readJson<{ songId?: unknown }>(c.req.raw);
  const songId = toStringValue(payload?.songId);
  if (!songId) return jsonError("Missing songId", 400);
  await c.get("db")`DELETE FROM "Like" WHERE "userId" = ${user.id} AND "songId" = ${songId}`;
  return c.json({ ok: true });
});

app.post("/api/playlist/:id/reorder", async (c) => {
  const user = requireUser(c.get("user"));
  const id = c.req.param("id");
  const db = c.get("db");
  const playlistRows = await db<{ id: string; userId: string }>`
    SELECT "id", "userId" FROM "Playlist" WHERE "id" = ${id} LIMIT 1
  `;
  const playlist = playlistRows[0];
  if (!playlist) return jsonError("Playlist not found", 404);
  if (playlist.userId !== user.id) return jsonError("Forbidden", 403);
  const payload = await readJson<{ songIds?: unknown }>(c.req.raw);
  if (!Array.isArray(payload?.songIds)) return jsonError("songIds must be an array", 400);
  const requested = [...new Set(payload.songIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
  const existingRows = await db<{ songId: string; order: number }>`
    SELECT "songId", "order" FROM "PlaylistSong" WHERE "playlistId" = ${id} ORDER BY "order" ASC
  `;
  const existingIds = existingRows.map((row) => row.songId);
  const existingSet = new Set(existingIds);
  const orderedRequested = requested.filter((songId) => existingSet.has(songId));
  const requestedSet = new Set(orderedRequested);
  const finalOrder = [...orderedRequested, ...existingIds.filter((songId) => !requestedSet.has(songId))];
  if (finalOrder.length > 0) {
    const orderJson = JSON.stringify(finalOrder);
    await db`
      UPDATE "PlaylistSong"
      SET "order" = (
        SELECT key FROM json_each(${orderJson})
        WHERE value = "PlaylistSong"."songId"
      )
      WHERE "playlistId" = ${id}
        AND "songId" IN (SELECT value FROM json_each(${orderJson}))
    `;
  }
  return c.json({ ok: true, songIds: finalOrder });
});

app.get("/api/files/*", async (c) => {
  const key = normalizeStorageKey(parseStorageKeyFromApiPath(new URL(c.req.url).pathname));
  const object = await c.env.MEDIA.head(key);
  if (!object) return jsonError("Not found", 404);
  const size = Number(object.size || 0);
  const contentType = object.httpMetadata?.contentType || inferContentTypeFromKey(key);
  const range = c.req.header("range");
  if (range) {
    const parsed = parseRangeHeader(range, size);
    if (!parsed) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
    const length = parsed.end - parsed.start + 1;
    const partial = await c.env.MEDIA.get(key, { range: { offset: parsed.start, length } });
    return new Response(partial?.body ?? null, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(length),
        "Content-Range": `bytes ${parsed.start}-${parsed.end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
  const full = await c.env.MEDIA.get(key);
  return new Response(full?.body ?? null, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.get("/api/artwork/*", (c) => c.redirect("/apple-icon.png", 302));

app.onError((error) => {
  if (error instanceof ApiError) {
    return jsonError(error.message, error.status);
  }
  console.error("[worker] unhandled error", error);
  return jsonError("Internal server error", 500);
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
