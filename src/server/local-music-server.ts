import { createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createWriteStream, existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { isIP } from "node:net";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseFile } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import type { PlayerSong } from "../types/player";

type LocalSongEntry = {
  song: PlayerSong;
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
};

type LibrarySnapshot = {
  songs: PlayerSong[];
  entriesById: Map<string, LocalSongEntry>;
  entriesByPath: Map<string, LocalSongEntry>;
  scannedAt: number;
};

type LibrarySource = {
  key: string;
  root: string;
  cachePath: string;
  artworkDir: string;
  shared: boolean;
};

type RequestUserIdentity = {
  id: string;
  email: string | null;
  name: string | null;
  local: boolean;
};

type PersistentSongCache = {
  version: 1;
  root: string;
  entries: Record<
    string,
    {
      size: number;
      mtimeMs: number;
      song: PlayerSong;
    }
  >;
};

type LocalSidecar = {
  version?: number;
  title?: string;
  artist?: string;
  album?: string;
  coverFile?: string;
  lyricsFile?: string;
  updatedAt?: string;
};

type KnownFileStat = {
  size: number;
  mtimeMs: number;
};

type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const LYRICS_EXTENSIONS = new Set([".lrc", ".txt"]);
const SCAN_CACHE_VERSION = 1;
const ARTWORK_CACHE_VERSION = 2;
const LOCAL_USER = {
  id: "local-mac-mini",
  email: "local@spotify.local",
  name: "Mac mini",
  image: null,
};
const PROXY_USER_ID_HEADER = "x-spotify-user-id";
const PROXY_USER_EMAIL_HEADER = "x-spotify-user-email";
const PROXY_USER_NAME_HEADER = "x-spotify-user-name";
const MEDIA_USER_SEARCH_PARAM = "spotify_user";
const MEDIA_SCOPE_SEARCH_PARAM = "spotify_scope";
const MEDIA_SIGNATURE_SEARCH_PARAM = "spotify_sig";

const cwd = process.cwd();
const defaultDistDir = existsSync(resolve(cwd, "dist/client"))
  ? resolve(cwd, "dist/client")
  : resolve(cwd, "dist");
const distDir = resolve(process.env.SPOTIFY_DIST_DIR || defaultDistDir);
const musicRoot = resolve(process.env.SPOTIFY_MUSIC_DIR || resolve(homedir(), "Music"));
const cacheDir = resolve(process.env.SPOTIFY_CACHE_DIR || resolve(cwd, "cache"));
const userMusicRoot = resolve(process.env.SPOTIFY_USER_MUSIC_DIR || resolve(cacheDir, "user-music"));
const libraryCachePath = resolve(
  process.env.SPOTIFY_LIBRARY_CACHE || resolve(cacheDir, "local-music-library.json"),
);
const artworkCacheDir = resolve(process.env.SPOTIFY_ARTWORK_CACHE_DIR || resolve(cacheDir, "artwork"));
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "5174");
const scanTtlMs = Math.max(1_000, Number(process.env.SPOTIFY_SCAN_TTL_MS || "30000"));
const configuredIdleTimeoutSeconds = Number(process.env.SPOTIFY_IDLE_TIMEOUT_SECONDS || "120");
const idleTimeoutSeconds = Number.isFinite(configuredIdleTimeoutSeconds)
  ? Math.max(30, configuredIdleTimeoutSeconds)
  : 120;
const remoteArtworkLookupEnabled = process.env.SPOTIFY_ARTWORK_LOOKUP !== "0";
const artworkLookupCountry = process.env.SPOTIFY_ARTWORK_COUNTRY || "GB";
const proxyToken = process.env.SPOTIFY_PROXY_TOKEN || "";
const proxyHostnames = new Set(
  (process.env.SPOTIFY_PROXY_HOSTNAMES || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const libraryOwnerUserIds = parseEnvList(process.env.SPOTIFY_LIBRARY_OWNER_USER_IDS || "");
const libraryOwnerEmails = parseEnvList(process.env.SPOTIFY_LIBRARY_OWNER_EMAILS || "");
const libraryOwnerNames = parseEnvList(process.env.SPOTIFY_LIBRARY_OWNER_NAMES || "Erlin");
const SERVER_IMPORT_OUTPUT_FORMAT: OutputFormat = "flac";
const OUTPUT_FORMATS = new Set<OutputFormat>(["flac", "mp3", "aac", "ogg", "opus", "wav"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_LYRICS_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 5;

let librarySnapshot: LibrarySnapshot | null = null;
let scanPromise: Promise<LibrarySnapshot> | null = null;
const userLibrarySnapshots = new Map<string, LibrarySnapshot>();
const userScanPromises = new Map<string, Promise<LibrarySnapshot>>();

function json(payload: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function ifNoneMatchMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === "*" || item === etag);
}

function jsonCached(
  request: Request,
  payload: unknown,
  init?: ResponseInit & { cacheControl?: string },
): Response {
  const { cacheControl, ...responseInit } = init ?? {};
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("hex").slice(0, 32)}"`;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheControl || "private, max-age=30, stale-while-revalidate=300");
  headers.set("etag", etag);

  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { ...responseInit, headers });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeIdentityValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseEnvList(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map(normalizeIdentityValue)
      .filter(Boolean),
  );
}

function listMatchesValue(list: Set<string>, value: string | null | undefined): boolean {
  if (list.has("*")) return true;
  if (!value) return false;
  return list.has(normalizeIdentityValue(value));
}

function stableUserDigest(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function sharedLibrarySource(): LibrarySource {
  return {
    key: "shared",
    root: musicRoot,
    cachePath: libraryCachePath,
    artworkDir: artworkCacheDir,
    shared: true,
  };
}

function userLibrarySource(userId: string): LibrarySource {
  const digest = stableUserDigest(userId);
  const base = resolve(userMusicRoot, digest);
  return {
    key: `user:${digest}`,
    root: resolve(base, "music"),
    cachePath: resolve(base, "local-music-library.json"),
    artworkDir: resolve(base, "artwork"),
    shared: false,
  };
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}

function requestHostname(request: Request): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return (request.headers.get("host") || "").split(":")[0]?.toLowerCase() || "";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function parseIpv4Host(host: string): number[] | null {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4Host(host: string): boolean {
  const octets = parseIpv4Host(host);
  if (!octets) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isTailscaleIpv4Host(host: string): boolean {
  const octets = parseIpv4Host(host);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isLocalNetworkHost(host: string): boolean {
  return (
    isLoopbackHost(host) ||
    host === "m4mini.local" ||
    host.endsWith(".local") ||
    isPrivateIpv4Host(host) ||
    isTailscaleIpv4Host(host)
  );
}

function hasValidProxyToken(request: Request): boolean {
  return Boolean(proxyToken && request.headers.get("x-spotify-proxy-token") === proxyToken);
}

function requestNeedsProxyToken(request: Request): boolean {
  if (!proxyToken) return false;
  const host = requestHostname(request);
  if (proxyHostnames.has(host)) return true;
  if (isLocalNetworkHost(host)) return false;
  return true;
}

function allowsImplicitLocalUser(request: Request): boolean {
  return !requestNeedsProxyToken(request) && isLocalNetworkHost(requestHostname(request));
}

function isMutationRequest(request: Request): boolean {
  const method = request.method.toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function authorizeMutationRequest(request: Request): Response | null {
  if (!isMutationRequest(request)) return null;
  if (hasValidProxyToken(request) || allowsImplicitLocalUser(request)) return null;
  return json({ error: "Unauthorized" }, { status: 401 });
}

function methodNotAllowed(): Response {
  return json({ error: "Method not allowed" }, { status: 405 });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeRelativePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function resolveInside(root: string, relativePath: string): string | null {
  const normalized = relativePath.split("/").filter(Boolean).join("/");
  if (!normalized || normalized.includes("\0")) return null;
  const absolutePath = resolve(root, normalized);
  return isPathInside(root, absolutePath) ? absolutePath : null;
}

function relativeFromUrlPath(pathname: string, prefix: string): string {
  return pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(safeDecode)
    .join("/");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".oga":
    case ".ogg":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".wav":
      return "audio/wav";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".lrc":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function parseRangeHeader(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=") || size <= 0) return null;
  const value = rangeHeader.slice("bytes=".length).trim();
  if (!value || value.includes(",")) return null;
  const dash = value.indexOf("-");
  if (dash < 0) return null;

  const startRaw = value.slice(0, dash);
  const endRaw = value.slice(dash + 1);
  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  let end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

async function serveFile(
  path: string,
  request: Request,
  cacheControl = "public, max-age=3600",
  knownFileStat?: KnownFileStat,
): Promise<Response> {
  let size: number;
  let mtimeMs: number;
  let mtime: Date;

  if (knownFileStat) {
    size = knownFileStat.size;
    mtimeMs = knownFileStat.mtimeMs;
    mtime = new Date(mtimeMs);
  } else {
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      return notFound();
    }
    if (!fileStat.isFile()) return notFound();
    size = fileStat.size;
    mtimeMs = fileStat.mtimeMs;
    mtime = fileStat.mtime;
  }

  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("content-type", contentTypeForPath(path));
  headers.set("last-modified", mtime.toUTCString());
  headers.set("etag", `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`);

  const range = parseRangeHeader(request.headers.get("range"), size);
  if (!range && ifNoneMatchMatches(request.headers.get("if-none-match"), headers.get("etag") || "")) {
    return new Response(null, { status: 304, headers });
  }

  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(request.method === "HEAD" ? null : Bun.file(path).slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }

  headers.set("content-length", String(size));
  return new Response(request.method === "HEAD" ? null : Bun.file(path), { headers });
}

function stableSongId(relativePath: string): string {
  const digest = createHash("sha1").update(relativePath).digest("hex").slice(0, 24);
  return `local-server:${digest}`;
}

function titleFromFileName(fileName: string): { title: string; artist: string } {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  const separator = stem.lastIndexOf(" - ");
  if (separator > 0) {
    return {
      title: stem.slice(0, separator).trim() || stem,
      artist: stem.slice(separator + 3).trim() || "Unknown Artist",
    };
  }
  return { title: stem || "Untitled", artist: "Unknown Artist" };
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(", ")
      .trim();
  }
  return "";
}

function normalizeSearchText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function textMatchScore(expected: unknown, candidate: unknown): number {
  const left = normalizeSearchText(expected);
  const right = normalizeSearchText(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;

  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function contentTypeExtension(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

function audioExtensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("aac")) return ".aac";
  if (normalized.includes("aiff") || normalized.includes("aif")) return ".aiff";
  if (normalized.includes("flac")) return ".flac";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("opus")) return ".opus";
  if (normalized.includes("wav")) return ".wav";
  return ".flac";
}

function extensionFromRemoteUrl(value: string, allowed: Set<string>, fallback: string): string {
  try {
    const parsed = new URL(value);
    const ext = extname(parsed.pathname).toLowerCase();
    return allowed.has(ext) ? ext : fallback;
  } catch {
    return fallback;
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isPrivateOrReservedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map((part) => Number(part));
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedIpAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

function isBlockedRemoteHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    !normalized.includes(".") ||
    (isIP(normalized) !== 0 && isPrivateOrReservedIpAddress(normalized))
  );
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteUrlError("Only valid http(s) URLs are supported");
  }
  if (url.username || url.password) {
    throw new RemoteUrlError("Remote URLs with credentials are not supported");
  }
  if (isBlockedRemoteHostname(url.hostname)) {
    throw new RemoteUrlError("Remote URL host is not allowed");
  }

  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw new RemoteUrlError("Remote URL host could not be resolved");
  if (addresses.some(({ address }) => isPrivateOrReservedIpAddress(address))) {
    throw new RemoteUrlError("Remote URL host resolves to a private network address");
  }
}

async function fetchPublicHttpUrl(url: URL, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  let nextUrl = url;
  let nextInit = { ...init };

  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_REDIRECTS; redirectCount += 1) {
    await assertPublicHttpUrl(nextUrl);
    const response = await fetchWithTimeout(
      nextUrl.toString(),
      { ...nextInit, redirect: "manual" },
      timeoutMs,
    );

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) return response;

    nextUrl = new URL(location, nextUrl);
    if (response.status === 303) {
      nextInit = { ...nextInit, method: "GET", body: undefined };
    }
  }

  throw new RemoteUrlError("Remote URL redirected too many times");
}

function outputFormatFromPayload(value: unknown): OutputFormat {
  const format = typeof value === "string"
    ? value.trim().toLowerCase() as OutputFormat
    : SERVER_IMPORT_OUTPUT_FORMAT;
  return OUTPUT_FORMATS.has(format) ? format : SERVER_IMPORT_OUTPUT_FORMAT;
}

function sidecarPathForAudio(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, ".spotify.json");
}

async function readSidecar(audioPath: string): Promise<LocalSidecar> {
  try {
    const raw = await readFile(sidecarPathForAudio(audioPath), "utf8");
    const parsed = JSON.parse(raw) as LocalSidecar;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSidecar(audioPath: string, sidecar: LocalSidecar): Promise<void> {
  const target = sidecarPathForAudio(audioPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

async function directoryNames(path: string, cache: Map<string, Promise<string[]>>): Promise<string[]> {
  const dir = dirname(path);
  let promise = cache.get(dir);
  if (!promise) {
    promise = readdir(dir).catch(() => []);
    cache.set(dir, promise);
  }
  return promise;
}

async function findSidecarByExtensions(
  source: LibrarySource,
  audioPath: string,
  extensions: Set<string>,
  candidates: string[],
  cache: Map<string, Promise<string[]>>,
): Promise<string> {
  const names = await directoryNames(audioPath, cache);
  const wanted = new Set(candidates.map((item) => item.toLowerCase()));
  const exact = names.find((name) => wanted.has(name.toLowerCase()) && extensions.has(extname(name).toLowerCase()));
  if (!exact) return "";
  const rel = relative(source.root, resolve(dirname(audioPath), exact)).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : "";
}

async function findCoverPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.coverFile) {
    const candidate = resolve(dirname(audioPath), sidecar.coverFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    IMAGE_EXTENSIONS,
    [
      `${stem}.cover.jpg`,
      `${stem}.cover.jpeg`,
      `${stem}.cover.png`,
      `${stem}.cover.webp`,
      `${stem}.jpg`,
      `${stem}.jpeg`,
      `${stem}.png`,
      `${stem}.webp`,
      "cover.jpg",
      "cover.jpeg",
      "cover.png",
      "cover.webp",
      "folder.jpg",
      "folder.jpeg",
      "folder.png",
      "folder.webp",
      "front.jpg",
      "front.jpeg",
      "front.png",
      "front.webp",
    ],
    cache,
  );
}

async function findLyricsPath(source: LibrarySource, audioPath: string, stem: string, sidecar: LocalSidecar, cache: Map<string, Promise<string[]>>): Promise<string> {
  if (sidecar.lyricsFile) {
    const candidate = resolve(dirname(audioPath), sidecar.lyricsFile);
    if (isPathInside(source.root, candidate) && existsSync(candidate)) {
      return relative(source.root, candidate).split(sep).join("/");
    }
  }

  return findSidecarByExtensions(
    source,
    audioPath,
    LYRICS_EXTENSIONS,
    [`${stem}.lrc`, `${stem}.lyrics.lrc`, `${stem}.txt`, `${stem}.lyrics.txt`],
    cache,
  );
}

async function songFromFile(
  source: LibrarySource,
  relativePath: string,
  absolutePath: string,
  fileStat: Stats,
  directoryCache: Map<string, Promise<string[]>>,
): Promise<PlayerSong> {
  const id = stableSongId(source.shared ? relativePath : `${source.key}/${relativePath}`);
  const fileName = basename(absolutePath);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const fallback = titleFromFileName(fileName);
  const sidecar = await readSidecar(absolutePath);
  let metadata: IAudioMetadata | null = null;

  try {
    metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
  } catch {
    metadata = null;
  }

  const common = metadata?.common;
  const format = metadata?.format;
  const artist =
    firstString(sidecar.artist) ||
    firstString(common?.artist) ||
    firstString(common?.artists) ||
    fallback.artist;
  const title = firstString(sidecar.title) || firstString(common?.title) || fallback.title;
  const album = firstString(sidecar.album) || firstString(common?.album);
  const coverPath = await findCoverPath(source, absolutePath, stem, sidecar, directoryCache);
  const lyricsPath = await findLyricsPath(source, absolutePath, stem, sidecar, directoryCache);

  return {
    id,
    title,
    artist,
    album: album || undefined,
    imageUrl: coverPath
      ? `/api/files/local/${encodeRelativePath(coverPath)}`
      : `/api/artwork/local/${encodeURIComponent(id)}`,
    audioUrl: `/api/files/local/${encodeRelativePath(relativePath)}`,
    lyricsUrl: lyricsPath ? `/api/files/local/${encodeRelativePath(lyricsPath)}` : undefined,
    createdAt: new Date(Number(fileStat.birthtimeMs || fileStat.mtimeMs)).toISOString(),
    duration:
      typeof format?.duration === "number" && Number.isFinite(format.duration)
        ? Math.round(format.duration)
        : undefined,
    audioBitDepth:
      typeof format?.bitsPerSample === "number" && Number.isFinite(format.bitsPerSample)
        ? format.bitsPerSample
        : undefined,
    audioSampleRate:
      typeof format?.sampleRate === "number" && Number.isFinite(format.sampleRate)
        ? format.sampleRate
        : undefined,
    source: "server",
    localPath: relativePath,
  };
}

async function collectAudioFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = resolve(dir, entry.name);
      if (!isPathInside(root, absolutePath)) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      output.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
      });
    }
  }

  await walk(root);
  return output;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function readPersistentCache(source: LibrarySource): Promise<PersistentSongCache> {
  try {
    const raw = await readFile(source.cachePath, "utf8");
    const parsed = JSON.parse(raw) as PersistentSongCache;
    if (parsed?.version === SCAN_CACHE_VERSION && parsed.root === source.root) return parsed;
  } catch {}
  return { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
}

async function writePersistentCache(source: LibrarySource, cache: PersistentSongCache): Promise<void> {
  await mkdir(dirname(source.cachePath), { recursive: true });
  const tempPath = `${source.cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(cache)}\n`, "utf8");
  await rename(tempPath, source.cachePath);
}

function buildLibrarySnapshot(entries: LocalSongEntry[], scannedAt = Date.now()): LibrarySnapshot {
  const songs = entries
    .map((entry) => entry.song)
    .sort((left, right) => {
      const leftKey = `${left.artist} ${left.title}`.toLowerCase();
      const rightKey = `${right.artist} ${right.title}`.toLowerCase();
      return leftKey.localeCompare(rightKey);
    });
  const entriesById = new Map(entries.map((entry) => [entry.song.id, entry] as const));
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry] as const));

  return {
    songs,
    entriesById,
    entriesByPath,
    scannedAt,
  };
}

async function readCachedLibrarySnapshot(source: LibrarySource): Promise<LibrarySnapshot | null> {
  const cache = await readPersistentCache(source);
  const entries: LocalSongEntry[] = [];

  for (const [relativePath, cached] of Object.entries(cache.entries)) {
    if (!cached?.song || typeof cached.size !== "number" || typeof cached.mtimeMs !== "number") continue;
    const absolutePath = resolveInside(source.root, relativePath);
    if (!absolutePath) continue;
    entries.push({
      song: cached.song,
      absolutePath,
      relativePath,
      size: cached.size,
      mtimeMs: cached.mtimeMs,
    });
  }

  return entries.length ? buildLibrarySnapshot(entries) : null;
}

function cachedStatMatches(
  cached: PersistentSongCache["entries"][string] | undefined,
  fileStat: Stats,
): cached is PersistentSongCache["entries"][string] {
  if (!cached || cached.size !== fileStat.size) return false;
  return Math.trunc(cached.mtimeMs) === Math.trunc(fileStat.mtimeMs);
}

async function scanLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  await mkdir(source.root, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const previous: PersistentSongCache = usePersistentCache
    ? await readPersistentCache(source)
    : { version: SCAN_CACHE_VERSION, root: source.root, entries: {} };
  const files = await collectAudioFiles(source.root);
  const directoryCache = new Map<string, Promise<string[]>>();
  const nextCache: PersistentSongCache = {
    version: SCAN_CACHE_VERSION,
    root: source.root,
    entries: {},
  };

  const entries = await mapWithConcurrency(files, 8, async (file) => {
    const fileStat = await stat(file.absolutePath);
    const cached = previous.entries[file.relativePath];
    const song =
      cachedStatMatches(cached, fileStat)
        ? cached.song
        : await songFromFile(source, file.relativePath, file.absolutePath, fileStat, directoryCache);

    nextCache.entries[file.relativePath] = {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      song,
    };

    return {
      song,
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  });

  await writePersistentCache(source, nextCache).catch(() => {});

  return buildLibrarySnapshot(entries);
}

function refreshLibrary(source: LibrarySource, usePersistentCache = true): Promise<LibrarySnapshot> {
  if (!source.shared) {
    const existing = userScanPromises.get(source.key);
    if (existing) return existing;
    const promise = scanLibrary(source, usePersistentCache)
      .then((snapshot) => {
        userLibrarySnapshots.set(source.key, snapshot);
        return snapshot;
      })
      .finally(() => {
        userScanPromises.delete(source.key);
      });
    userScanPromises.set(source.key, promise);
    return promise;
  }

  scanPromise ??= scanLibrary(source, usePersistentCache)
    .then((snapshot) => {
      librarySnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      scanPromise = null;
    });
  return scanPromise;
}

async function getLibrary(source: LibrarySource, force = false): Promise<LibrarySnapshot> {
  const now = Date.now();
  const snapshot = source.shared ? librarySnapshot : userLibrarySnapshots.get(source.key) ?? null;
  const activePromise = source.shared ? scanPromise : userScanPromises.get(source.key) ?? null;
  if (!force && snapshot) {
    if (now - snapshot.scannedAt >= scanTtlMs && !activePromise) {
      void refreshLibrary(source, true).catch((error) => {
        console.error(`Spotify local music library refresh failed for ${source.key}: ${error}`);
      });
    }
    return snapshot;
  }
  return refreshLibrary(source, !force);
}

function currentUserIdentityForRequest(request: Request): RequestUserIdentity | null {
  if (hasValidProxyToken(request)) {
    const id = request.headers.get(PROXY_USER_ID_HEADER)?.trim() || "";
    if (!id) return null;
    return {
      id,
      email: request.headers.get(PROXY_USER_EMAIL_HEADER)?.trim() || null,
      name: request.headers.get(PROXY_USER_NAME_HEADER)?.trim() || null,
      local: false,
    };
  }
  return allowsImplicitLocalUser(request)
    ? {
        id: LOCAL_USER.id,
        email: LOCAL_USER.email,
        name: LOCAL_USER.name,
        local: true,
      }
    : null;
}

function currentUserIdForRequest(request: Request): string | null {
  return currentUserIdentityForRequest(request)?.id ?? null;
}

function isLocalLibraryOwner(identity: RequestUserIdentity | null): boolean {
  if (!identity) return false;
  if (identity.local || identity.id === LOCAL_USER.id) return true;
  return (
    listMatchesValue(libraryOwnerUserIds, identity.id) ||
    listMatchesValue(libraryOwnerEmails, identity.email) ||
    listMatchesValue(libraryOwnerNames, identity.name)
  );
}

function librarySourceForIdentity(identity: RequestUserIdentity | null): LibrarySource | null {
  if (!identity) return null;
  return isLocalLibraryOwner(identity) ? sharedLibrarySource() : userLibrarySource(identity.id);
}

function librarySourceForRequest(request: Request): LibrarySource | null {
  return librarySourceForIdentity(currentUserIdentityForRequest(request));
}

function canAccessLocalLibrary(request: Request): boolean {
  return Boolean(librarySourceForRequest(request));
}

function forbiddenLibraryResponse(): Response {
  return json({ error: "This account does not have access to the local music library" }, { status: 403 });
}

function mediaScopeForIdentity(identity: RequestUserIdentity): "shared" | "user" {
  return isLocalLibraryOwner(identity) ? "shared" : "user";
}

function mediaSignature(userId: string, scope: string, pathname: string): string {
  return createHmac("sha256", proxyToken)
    .update(userId)
    .update("\0")
    .update(scope)
    .update("\0")
    .update(pathname)
    .digest("hex")
    .slice(0, 40);
}

function appendMediaSignature(mediaUrl: string | undefined, identity: RequestUserIdentity | null): string | undefined {
  if (!mediaUrl || !proxyToken || !identity || identity.local) return mediaUrl;
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl, "http://spotify.local");
  } catch {
    return mediaUrl;
  }
  if (!parsed.pathname.startsWith("/api/files/local/") && !parsed.pathname.startsWith("/api/artwork/local/")) {
    return mediaUrl;
  }
  const scope = mediaScopeForIdentity(identity);
  parsed.searchParams.set(MEDIA_USER_SEARCH_PARAM, identity.id);
  parsed.searchParams.set(MEDIA_SCOPE_SEARCH_PARAM, scope);
  parsed.searchParams.set(MEDIA_SIGNATURE_SEARCH_PARAM, mediaSignature(identity.id, scope, parsed.pathname));
  return `${parsed.pathname}${parsed.search}`;
}

function songForRequest(song: PlayerSong, request: Request): PlayerSong {
  const identity = currentUserIdentityForRequest(request);
  return {
    ...song,
    imageUrl: appendMediaSignature(song.imageUrl, identity) || song.imageUrl,
    audioUrl: appendMediaSignature(song.audioUrl, identity) || song.audioUrl,
    lyricsUrl: appendMediaSignature(song.lyricsUrl, identity),
  };
}

function songsForRequest(songs: PlayerSong[], request: Request): PlayerSong[] {
  if (!canAccessLocalLibrary(request)) return [];
  return songs.map((song) => songForRequest(song, request));
}

function hasValidMediaSignature(url: URL): boolean {
  if (!proxyToken) return false;
  const userId = url.searchParams.get(MEDIA_USER_SEARCH_PARAM)?.trim() || "";
  const scope = url.searchParams.get(MEDIA_SCOPE_SEARCH_PARAM)?.trim() || "";
  const signature = url.searchParams.get(MEDIA_SIGNATURE_SEARCH_PARAM)?.trim() || "";
  return Boolean(
    userId &&
    (scope === "shared" || scope === "user") &&
    signature &&
    signature === mediaSignature(userId, scope, url.pathname),
  );
}

function librarySourceForMediaRequest(request: Request, url: URL): LibrarySource | null {
  const requestSource = librarySourceForRequest(request);
  if (requestSource) return requestSource;
  if (!hasValidMediaSignature(url)) return null;
  const userId = url.searchParams.get(MEDIA_USER_SEARCH_PARAM)?.trim() || "";
  const scope = url.searchParams.get(MEDIA_SCOPE_SEARCH_PARAM)?.trim() || "";
  return scope === "shared" ? sharedLibrarySource() : userLibrarySource(userId);
}

function likedSongIdsForSongs(songs: PlayerSong[]): string[] {
  return songs.map((song) => song.id);
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleLikes(request: Request): Promise<Response> {
  const source = librarySourceForRequest(request);
  const visibleSongs = source ? songsForRequest((await getLibrary(source)).songs, request) : [];
  const likedSongIds = likedSongIdsForSongs(visibleSongs);

  if (request.method === "GET") {
    return jsonCached(request, { likes: likedSongIds, likedSongIds });
  }

  if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed();
  if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
  if (!source) return forbiddenLibraryResponse();

  const payload = await readJsonBody<{ songId?: unknown }>(request);
  const songId = typeof payload?.songId === "string" ? payload.songId : "";
  if (!songId) return json({ error: "Song id is required" }, { status: 400 });
  if (!likedSongIds.includes(songId)) return notFound("Song not found");

  return json({ ok: true, likes: likedSongIds, likedSongIds });
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180) || "Unknown";
}

async function uniquePath(basePath: string): Promise<string> {
  if (!existsSync(basePath)) return basePath;
  const ext = extname(basePath);
  const stem = basePath.slice(0, -ext.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} ${index}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to create a unique file name");
}

async function saveFile(file: File, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSupportedUploadFile(file: File, allowedExtensions: Set<string>, mimePrefix: string): boolean {
  const ext = extname(file.name).toLowerCase();
  const mimeType = file.type.toLowerCase();
  return allowedExtensions.has(ext) || (mimeType ? mimeType.startsWith(mimePrefix) : false);
}

function validateUploadFile(
  file: File,
  label: string,
  maxBytes: number,
  allowedExtensions?: Set<string>,
  mimePrefix?: string,
): Response | null {
  if (file.size > maxBytes) {
    return json({ error: `${label} is too large` }, { status: 413 });
  }
  if (allowedExtensions && mimePrefix && !isSupportedUploadFile(file, allowedExtensions, mimePrefix)) {
    return json({ error: `${label} type is not supported` }, { status: 415 });
  }
  return null;
}

function assertRemoteResponseSize(response: Response, maxBytes: number, label: string): void {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PayloadTooLargeError(`${label} is too large`);
  }
}

function byteLimitTransform(maxBytes: number, label: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(new PayloadTooLargeError(`${label} is too large`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function saveResponseBody(response: Response, path: string, maxBytes?: number, label = "File"): Promise<void> {
  if (!response.body) throw new Error("Remote file response had no body");
  if (maxBytes) assertRemoteResponseSize(response, maxBytes, label);
  await mkdir(dirname(path), { recursive: true });
  try {
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    if (maxBytes) {
      await pipeline(source, byteLimitTransform(maxBytes, label), createWriteStream(path));
    } else {
      await pipeline(source, createWriteStream(path));
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function deleteSongEntryFiles(source: LibrarySource, entry: LocalSongEntry): Promise<void> {
  const sidecar = await readSidecar(entry.absolutePath);
  await Promise.all([
    rm(entry.absolutePath, { force: true }).catch(() => undefined),
    rm(sidecarPathForAudio(entry.absolutePath), { force: true }).catch(() => undefined),
  ]);

  for (const fileName of [sidecar.coverFile, sidecar.lyricsFile]) {
    if (!fileName) continue;
    const candidate = resolve(dirname(entry.absolutePath), fileName);
    if (isPathInside(source.root, candidate)) {
      await rm(candidate, { force: true }).catch(() => undefined);
    }
  }
}

function trackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

async function saveRemoteImage(imageUrl: string, stem: string, audioPath: string): Promise<string | undefined> {
  const parsed = parseHttpUrl(imageUrl);
  if (!parsed) return undefined;

  const response = await fetchPublicHttpUrl(
    parsed,
    { headers: { accept: "image/*,*/*" } },
    20_000,
  );
  if (!response.ok || !response.body) return undefined;

  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) return undefined;

  const ext = extensionFromRemoteUrl(
    imageUrl,
    IMAGE_EXTENSIONS,
    contentTypeExtension(contentType || "image/jpeg"),
  );
  const coverName = `${stem}.cover${ext}`;
  await saveResponseBody(response, resolve(dirname(audioPath), coverName), MAX_IMAGE_BYTES, "Image file");
  return coverName;
}

async function handleRemoteSongUpload(payload: {
  source: LibrarySource;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  audioUrl?: unknown;
  imageUrl?: unknown;
  lyricsText?: unknown;
  replaceExisting?: unknown;
  outputFormat?: unknown;
}): Promise<Response> {
  const { source } = payload;
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload.artist === "string" ? payload.artist.trim() : "";
  const album = typeof payload.album === "string" ? payload.album.trim() : "";
  const audioUrl = typeof payload.audioUrl === "string" ? payload.audioUrl.trim() : "";
  const imageUrl = typeof payload.imageUrl === "string" ? payload.imageUrl.trim() : "";
  const lyricsText = typeof payload.lyricsText === "string" ? payload.lyricsText.trim() : "";
  const replaceExisting =
    payload.replaceExisting === true ||
    (typeof payload.replaceExisting === "string" && payload.replaceExisting.toLowerCase() === "true");
  const outputFormat = outputFormatFromPayload(payload.outputFormat);

  if (!title || !artist || !audioUrl) {
    return json({ error: "Title, artist, and audio URL are required" }, { status: 400 });
  }
  if (outputFormat !== SERVER_IMPORT_OUTPUT_FORMAT) {
    return json(
      {
        error: `${outputFormat.toUpperCase()} output is only available for browser/local saves. Server imports currently support FLAC/original audio.`,
      },
      { status: 400 },
    );
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  const parsedAudioUrl = parseHttpUrl(audioUrl);
  if (!parsedAudioUrl) return json({ error: "Only valid http(s) audio URLs are supported" }, { status: 400 });
  let response: Response;
  try {
    response = await fetchPublicHttpUrl(parsedAudioUrl, { headers: { accept: "audio/*,*/*" } }, 120_000);
  } catch (error) {
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const snapshot = await getLibrary(source);
  const existingEntry = snapshot.songs
    .map((song) => snapshot.entriesById.get(song.id))
    .find((entry): entry is LocalSongEntry =>
      Boolean(entry && trackKey(entry.song.title, entry.song.artist) === trackKey(title, artist)),
    );

  if (existingEntry && !replaceExisting) {
    return json(
      {
        error: "Song already exists in your library",
        code: "DUPLICATE_SONG",
        existingSong: {
          id: existingEntry.song.id,
          title: existingEntry.song.title,
          artist: existingEntry.song.artist,
        },
      },
      { status: 409 },
    );
  }

  if (!response.ok || !response.body) {
    return json({ error: `Audio server returned ${response.status}` }, { status: 502 });
  }

  const contentType = response.headers.get("content-type") || "";
  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (
    normalizedContentType &&
    !normalizedContentType.startsWith("audio/") &&
    normalizedContentType !== "application/octet-stream"
  ) {
    return json({ error: "Remote audio URL did not return an audio file" }, { status: 415 });
  }
  const audioExt = extensionFromRemoteUrl(
    audioUrl,
    AUDIO_EXTENSIONS,
    audioExtensionFromContentType(contentType),
  );
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const preferredAudioPath = existingEntry && replaceExisting
    ? resolve(dirname(existingEntry.absolutePath), `${stem}${audioExt}`)
    : resolve(source.root, `${stem}${audioExt}`);
  const audioPath =
    existingEntry &&
    replaceExisting &&
    (!existsSync(preferredAudioPath) || preferredAudioPath === existingEntry.absolutePath)
      ? preferredAudioPath
      : await uniquePath(preferredAudioPath);
  const tempAudioPath = existingEntry && replaceExisting
    ? await uniquePath(resolve(
        dirname(audioPath),
        `.${basename(audioPath, extname(audioPath))}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp${audioExt}`,
      ))
    : audioPath;

  try {
    await saveResponseBody(response, tempAudioPath, MAX_AUDIO_BYTES, "Audio file");
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return json({ error: error.message }, { status: 413 });
    }
    if (error instanceof RemoteUrlError) {
      return json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (existingEntry && replaceExisting) {
    await deleteSongEntryFiles(source, existingEntry);
    await mkdir(dirname(audioPath), { recursive: true });
    await rename(tempAudioPath, audioPath);
  }

  const sidecar: LocalSidecar = {
    version: 1,
    title,
    artist,
    album: album || undefined,
    updatedAt: new Date().toISOString(),
  };

  if (imageUrl) {
    sidecar.coverFile = await saveRemoteImage(imageUrl, basename(audioPath, extname(audioPath)), audioPath).catch(
      () => undefined,
    );
  }

  if (lyricsText) {
    const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
    await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
    sidecar.lyricsFile = lyricsName;
  }

  await writeSidecar(audioPath, sidecar);
  const nextSnapshot = await getLibrary(source, true);
  const relativePath = relative(source.root, audioPath).split(sep).join("/");
  const entry = nextSnapshot.entriesByPath.get(relativePath);
  if (!entry) return json({ error: "Uploaded song could not be scanned" }, { status: 500 });
  return json(entry.song, { status: existingEntry && replaceExisting ? 200 : 201 });
}

async function handleSongUpload(source: LibrarySource, request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("application/json")) {
    const payload = await readJsonBody<{
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      audioUrl?: unknown;
      imageUrl?: unknown;
      lyricsText?: unknown;
      replaceExisting?: unknown;
      outputFormat?: unknown;
    }>(request);
    if (!payload) return json({ error: "Invalid JSON body" }, { status: 400 });
    return handleRemoteSongUpload({ ...payload, source });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const title = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const artist = typeof form.get("artist") === "string" ? String(form.get("artist")).trim() : "";
  const image = form.get("image");
  const audio = form.get("audio");
  if (!title || !artist || !(audio instanceof File)) {
    return json({ error: "Title, artist, and audio are required" }, { status: 400 });
  }
  const invalidAudio = validateUploadFile(audio, "Audio file", MAX_AUDIO_BYTES, AUDIO_EXTENSIONS, "audio/");
  if (invalidAudio) return invalidAudio;
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
  }
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  const audioExt = AUDIO_EXTENSIONS.has(extname(audio.name).toLowerCase())
    ? extname(audio.name).toLowerCase()
    : ".mp3";
  const stem = sanitizeFileName(`${artist} - ${title}`);
  const audioPath = await uniquePath(resolve(source.root, `${stem}${audioExt}`));
  await saveFile(audio, audioPath);

  const sidecar: LocalSidecar = {
    version: 1,
    title,
    artist,
    updatedAt: new Date().toISOString(),
  };

  if (image instanceof File && image.size > 0) {
    const imageExt = IMAGE_EXTENSIONS.has(extname(image.name).toLowerCase())
      ? extname(image.name).toLowerCase()
      : ".jpg";
    const coverName = `${basename(audioPath, extname(audioPath))}.cover${imageExt}`;
    await saveFile(image, resolve(dirname(audioPath), coverName));
    sidecar.coverFile = coverName;
  }

  if (lyricsText) {
    const lyricsName = `${basename(audioPath, extname(audioPath))}.lrc`;
    await writeFile(resolve(dirname(audioPath), lyricsName), `${lyricsText}\n`, "utf8");
    sidecar.lyricsFile = lyricsName;
  }

  await writeSidecar(audioPath, sidecar);
  const snapshot = await getLibrary(source, true);
  const relativePath = relative(source.root, audioPath).split(sep).join("/");
  const entry = snapshot.entriesByPath.get(relativePath);
  if (!entry) return json({ error: "Uploaded song could not be scanned" }, { status: 500 });
  return json(entry.song, { status: 201 });
}

async function handlePatchSong(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const payload = await readJsonBody<{ title?: unknown; artist?: unknown }>(request);
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  const artist = typeof payload?.artist === "string" ? payload.artist.trim() : "";
  if (!title || !artist) return json({ error: "Title and artist are required" }, { status: 400 });

  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");
  const currentSidecar = await readSidecar(entry.absolutePath);
  await writeSidecar(entry.absolutePath, {
    ...currentSidecar,
    version: 1,
    title,
    artist,
    updatedAt: new Date().toISOString(),
  });
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}

async function handleSongAssets(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return notFound("Song not found");

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form body" }, { status: 400 });
  const sidecar = await readSidecar(entry.absolutePath);
  const stem = basename(entry.absolutePath, extname(entry.absolutePath));
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsText = typeof form.get("lyricsText") === "string" ? String(form.get("lyricsText")).trim() : "";
  if (image instanceof File && image.size > 0) {
    const invalidImage = validateUploadFile(image, "Image file", MAX_IMAGE_BYTES, IMAGE_EXTENSIONS, "image/");
    if (invalidImage) return invalidImage;
  }
  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const invalidLyrics = validateUploadFile(lyricsFile, "Lyrics file", MAX_LYRICS_BYTES, LYRICS_EXTENSIONS, "text/");
    if (invalidLyrics) return invalidLyrics;
  }
  if (byteLength(lyricsText) > MAX_LYRICS_BYTES) {
    return json({ error: "Lyrics text is too large" }, { status: 413 });
  }

  if (image instanceof File && image.size > 0) {
    const imageExt = IMAGE_EXTENSIONS.has(extname(image.name).toLowerCase())
      ? extname(image.name).toLowerCase()
      : ".jpg";
    const coverName = `${stem}.cover${imageExt}`;
    await saveFile(image, resolve(dirname(entry.absolutePath), coverName));
    sidecar.coverFile = coverName;
  }

  if (lyricsFile instanceof File && lyricsFile.size > 0) {
    const lyricsExt = LYRICS_EXTENSIONS.has(extname(lyricsFile.name).toLowerCase())
      ? extname(lyricsFile.name).toLowerCase()
      : ".lrc";
    const lyricsName = `${stem}${lyricsExt}`;
    await saveFile(lyricsFile, resolve(dirname(entry.absolutePath), lyricsName));
    sidecar.lyricsFile = lyricsName;
  } else if (lyricsText) {
    const lyricsName = `${stem}.lrc`;
    await writeFile(resolve(dirname(entry.absolutePath), lyricsName), `${lyricsText}\n`, "utf8");
    sidecar.lyricsFile = lyricsName;
  }

  sidecar.updatedAt = new Date().toISOString();
  await writeSidecar(entry.absolutePath, sidecar);
  const nextSnapshot = await getLibrary(source, true);
  const updated = nextSnapshot.entriesById.get(id);
  return updated ? json(updated.song) : notFound("Song not found");
}

type ItunesArtworkResult = {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  artworkUrl100?: string;
};

type DownloadedArtwork = {
  data: Uint8Array;
  contentType: string;
  sourceUrl: string;
};

class PayloadTooLargeError extends Error {}

class RemoteUrlError extends Error {}

function scoreItunesArtwork(song: PlayerSong, result: ItunesArtworkResult): number {
  if (!result.artworkUrl100) return 0;
  const titleScore = textMatchScore(song.title, result.trackName);
  const artistScore = textMatchScore(song.artist, result.artistName);
  const albumScore = song.album ? textMatchScore(song.album, result.collectionName) : 0;
  return titleScore * 4 + artistScore * 3 + albumScore * 2;
}

function highResolutionItunesArtworkUrl(url: string): string {
  return url.replace(/\/[0-9]+x[0-9]+bb\.(jpg|jpeg|png|webp)$/i, "/600x600bb.$1");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupRemoteArtwork(song: PlayerSong): Promise<DownloadedArtwork | null> {
  if (!remoteArtworkLookupEnabled) return null;

  const searchTerm = [song.artist, song.album || song.title].filter(Boolean).join(" ");
  if (!searchTerm.trim()) return null;

  const searchUrl = new URL("https://itunes.apple.com/search");
  searchUrl.searchParams.set("media", "music");
  searchUrl.searchParams.set("entity", "song");
  searchUrl.searchParams.set("limit", "10");
  searchUrl.searchParams.set("country", artworkLookupCountry);
  searchUrl.searchParams.set("term", searchTerm);

  const searchResponse = await fetchWithTimeout(searchUrl.toString(), {
    headers: { accept: "application/json" },
  });
  if (!searchResponse.ok) return null;

  const payload = (await searchResponse.json().catch(() => null)) as {
    results?: ItunesArtworkResult[];
  } | null;
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const best = results
    .map((result) => ({ result, score: scoreItunesArtwork(song, result) }))
    .sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 4 || !best.result.artworkUrl100) return null;

  const artworkUrl = highResolutionItunesArtworkUrl(best.result.artworkUrl100);
  const artworkResponse = await fetchWithTimeout(artworkUrl);
  if (!artworkResponse.ok) return null;
  const contentType = artworkResponse.headers.get("content-type") || "image/jpeg";
  if (!contentType.toLowerCase().startsWith("image/")) return null;

  const data = new Uint8Array(await artworkResponse.arrayBuffer());
  if (data.byteLength < 256) return null;
  return { data, contentType, sourceUrl: artworkUrl };
}

async function handleArtwork(source: LibrarySource, id: string, request: Request): Promise<Response> {
  const snapshot = await getLibrary(source);
  const entry = snapshot.entriesById.get(id);
  if (!entry) return Response.redirect("/apple-icon.png", 302);

  const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, "_");
  const cacheMetaPath = resolve(source.artworkDir, `${safeId}.json`);
  const signature = `${entry.relativePath}:${entry.size}:${entry.mtimeMs}`;

  try {
    const meta = JSON.parse(await readFile(cacheMetaPath, "utf8")) as {
      version?: number;
      signature?: string;
      contentType?: string;
      fileName?: string;
      empty?: boolean;
      sourceUrl?: string;
    };
    if (meta.version === ARTWORK_CACHE_VERSION && meta.signature === signature) {
      if (meta.empty) return Response.redirect("/apple-icon.png", 302);
      if (meta.fileName) {
        const cachedArtwork = resolve(source.artworkDir, meta.fileName);
        return serveFile(cachedArtwork, request, "public, max-age=86400");
      }
    }
  } catch {}

  await mkdir(source.artworkDir, { recursive: true });
  try {
    const metadata = await parseFile(entry.absolutePath, { skipCovers: false });
    const picture = metadata.common.picture?.[0];
    const embeddedArtwork = picture?.data?.byteLength
      ? {
          data: picture.data,
          contentType: picture.format || "image/jpeg",
          sourceUrl: "embedded",
        }
      : null;
    const artwork = embeddedArtwork || (await lookupRemoteArtwork(entry.song));

    if (artwork) {
      const fileName = `${safeId}${contentTypeExtension(artwork.contentType)}`;
      await writeFile(resolve(source.artworkDir, fileName), artwork.data);
      await writeFile(
        cacheMetaPath,
        `${JSON.stringify({
          version: ARTWORK_CACHE_VERSION,
          signature,
          contentType: artwork.contentType,
          fileName,
          sourceUrl: artwork.sourceUrl,
        })}\n`,
        "utf8",
      );
      return serveFile(resolve(source.artworkDir, fileName), request, "public, max-age=86400");
    }

    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({ version: ARTWORK_CACHE_VERSION, signature, empty: true })}\n`,
      "utf8",
    );
    return Response.redirect("/apple-icon.png", 302);
  } catch {
    await writeFile(
      cacheMetaPath,
      `${JSON.stringify({ version: ARTWORK_CACHE_VERSION, signature, empty: true })}\n`,
      "utf8",
    ).catch(() => {});
    return Response.redirect("/apple-icon.png", 302);
  }
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const pathname = url.pathname;

  if (requestNeedsProxyToken(request) && request.headers.get("x-spotify-proxy-token") !== proxyToken) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const unauthorizedMutation = authorizeMutationRequest(request);
  if (unauthorizedMutation) return unauthorizedMutation;

  if (pathname === "/api/auth/session" && request.method === "GET") {
    return json({ user: currentUserIdForRequest(request) ? LOCAL_USER : null });
  }
  if (pathname === "/api/auth/me" && request.method === "GET") {
    return json({ user: currentUserIdForRequest(request) ? LOCAL_USER : null });
  }
  if (pathname === "/api/auth/signout" && request.method === "POST") {
    return new Response(null, { status: 204 });
  }
  if (pathname === "/api/auth/signin" && request.method === "POST") {
    return json({ user: LOCAL_USER });
  }
  if (pathname === "/api/register" && request.method === "POST") {
    return json({ ok: true }, { status: 201 });
  }

  if (pathname === "/api/music/source" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, {
        root: null,
        songsCount: 0,
        scannedAt: null,
      }, { cacheControl: "private, max-age=15, stale-while-revalidate=120" });
    }
    const snapshot = await getLibrary(source, url.searchParams.get("refresh") === "1");
    return jsonCached(request, {
      root: source.root,
      songsCount: snapshot.songs.length,
      scannedAt: new Date(snapshot.scannedAt).toISOString(),
    }, { cacheControl: "private, max-age=15, stale-while-revalidate=120" });
  }

  if (pathname === "/api/home" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, {
        songs: [],
        likedSongIds: [],
      });
    }
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    return jsonCached(request, {
      songs,
      likedSongIds: likedSongIdsForSongs(songs),
    });
  }

  if (pathname === "/api/search-index" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) {
      return jsonCached(request, { songs: [] }, { cacheControl: "private, max-age=300, stale-while-revalidate=600" });
    }
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    return jsonCached(request, {
      songs: songs.map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        imageUrl: song.imageUrl,
        audioUrl: song.audioUrl,
        createdAt: song.createdAt,
        source: song.source,
        localPath: song.localPath,
      })),
    }, { cacheControl: "private, max-age=300, stale-while-revalidate=600" });
  }

  if (pathname === "/api/library" && request.method === "GET") {
    return jsonCached(request, { playlists: [], userId: currentUserIdForRequest(request) }, {
      cacheControl: "private, max-age=300, stale-while-revalidate=600",
    });
  }

  if (pathname === "/api/liked" && request.method === "GET") {
    if (!currentUserIdForRequest(request)) return json({ error: "Unauthorized" }, { status: 401 });
    const source = librarySourceForRequest(request);
    if (!source) return forbiddenLibraryResponse();
    const snapshot = await getLibrary(source);
    const songs = songsForRequest(snapshot.songs, request);
    return jsonCached(request, {
      songs,
      likedSongIds: likedSongIdsForSongs(songs),
    });
  }

  if (pathname === "/api/likes") {
    return handleLikes(request);
  }

  if (pathname === "/api/songs" && request.method === "GET") {
    const source = librarySourceForRequest(request);
    if (!source) return jsonCached(request, []);
    const snapshot = await getLibrary(source);
    return jsonCached(request, songsForRequest(snapshot.songs, request));
  }

  if (pathname === "/api/songs" && request.method === "POST") {
    const source = librarySourceForRequest(request);
    if (!source) return forbiddenLibraryResponse();
    return handleSongUpload(source, request);
  }

  if (pathname.startsWith("/api/songs/")) {
    const rest = pathname.slice("/api/songs/".length);
    if (rest.endsWith("/assets")) {
      const id = safeDecode(rest.slice(0, -"/assets".length));
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return request.method === "POST" ? handleSongAssets(source, id, request) : methodNotAllowed();
    }
    const id = safeDecode(rest);
    if (request.method === "GET") {
      const source = librarySourceForRequest(request);
      if (!source) return notFound("Song not found");
      const snapshot = await getLibrary(source);
      const entry = snapshot.entriesById.get(id);
      return entry ? jsonCached(request, songForRequest(entry.song, request)) : notFound("Song not found");
    }
    if (request.method === "PATCH") {
      const source = librarySourceForRequest(request);
      if (!source) return forbiddenLibraryResponse();
      return handlePatchSong(source, id, request);
    }
    return methodNotAllowed();
  }

  if (pathname.startsWith("/api/files/local/")) {
    const source = librarySourceForMediaRequest(request, url);
    if (!source) return forbiddenLibraryResponse();
    const relativePath = relativeFromUrlPath(pathname, "/api/files/local/");
    const absolutePath = resolveInside(source.root, relativePath);
    const snapshot = source.shared ? librarySnapshot : userLibrarySnapshots.get(source.key) ?? null;
    const knownEntry = snapshot?.entriesByPath.get(relativePath);
    const knownFileStat = knownEntry
      ? { size: knownEntry.size, mtimeMs: knownEntry.mtimeMs }
      : undefined;
    return absolutePath ? serveFile(absolutePath, request, "public, max-age=3600", knownFileStat) : notFound();
  }

  if (pathname.startsWith("/api/artwork/local/")) {
    const source = librarySourceForMediaRequest(request, url);
    if (!source) return forbiddenLibraryResponse();
    const id = safeDecode(pathname.slice("/api/artwork/local/".length));
    return handleArtwork(source, id, request);
  }

  if (pathname.startsWith("/api/songs/spotify")) {
    return json(
      { error: "Spotify download endpoints are not available in local music server mode." },
      { status: 501 },
    );
  }

  return notFound();
}

async function serveStaticAsset(request: Request, url: URL): Promise<Response> {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = requestedPath
    .split("/")
    .filter(Boolean)
    .map(safeDecode)
    .join("/");
  const absolutePath = resolveInside(distDir, relativePath);

  if (absolutePath && existsSync(absolutePath)) {
    const cacheControl =
      relativePath === "index.html"
        ? "no-store"
        : relativePath === "sw.js"
          ? "no-cache"
          : relativePath === "manifest.webmanifest"
            ? "public, max-age=3600"
            : relativePath.startsWith("assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600";
    return serveFile(absolutePath, request, cacheControl);
  }

  const indexPath = resolve(distDir, "index.html");
  if (existsSync(indexPath)) {
    return serveFile(indexPath, request, "no-store");
  }

  return text(`Missing built frontend at ${distDir}. Run bun run build first.`, 500);
}

Bun.serve({
  hostname: host,
  port,
  idleTimeout: idleTimeoutSeconds,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, url);
      }
      return await serveStaticAsset(request, url);
    } catch (error) {
      console.error(error);
      return json(
        { error: error instanceof Error ? error.message : "Internal server error" },
        { status: 500 },
      );
    }
  },
});

async function initializeLibrary(): Promise<void> {
  const source = sharedLibrarySource();
  const cachedSnapshot = await readCachedLibrarySnapshot(source);
  if (cachedSnapshot) {
    librarySnapshot = cachedSnapshot;
    console.log(
      `Spotify local music server listening on http://${host}:${port} with ${cachedSnapshot.songs.length} cached tracks from ${source.root}`,
    );
    void refreshLibrary(source, true)
      .then((snapshot) => {
        console.log(`Spotify local music server refreshed ${snapshot.songs.length} tracks from ${source.root}`);
      })
      .catch((error) => {
        console.error(`Spotify local music server started, but background refresh failed: ${error}`);
      });
    return;
  }

  const snapshot = await refreshLibrary(source, true);
  console.log(
    `Spotify local music server listening on http://${host}:${port} with ${snapshot.songs.length} tracks from ${source.root}`,
  );
}

void initializeLibrary().catch((error) => {
  console.error(`Spotify local music server started, but initial scan failed: ${error}`);
});
