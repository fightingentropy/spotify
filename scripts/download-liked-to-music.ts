import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import { resolveAmazonStreamUrl, type AmazonStream } from "../src/lib/amazon-download";
import { resolveQobuzStreamUrl } from "../src/lib/qobuz-download";
import { fetchSpotifyLikedTracks, type SpotifyBatchTrack } from "../src/lib/spotify-pathfinder";
import { resolveTidalStreamUrl } from "../src/lib/tidal-download";

type SpotifyTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  imageUrl: string;
};

type Options = {
  baseUrl: string;
  musicDir: string;
  region: string;
  qualityProfile: "cd" | "hires48" | "max";
  provider: "auto" | "qobuz" | "tidal" | "amazon";
  limit: number | null;
  delayMs: number;
  dryRun: boolean;
  useAppApi: boolean;
};

const AUDIO_EXTENSIONS = new Set([".flac"]);
const execFileAsync = promisify(execFile);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    baseUrl: process.env.SPOTIFY_APP_URL || "http://127.0.0.1:5174",
    musicDir: process.env.MUSIC_DIR || join(process.env.HOME || ".", "Music"),
    region: process.env.SPOTIFY_REGION || "US",
    qualityProfile: "max",
    provider: "auto",
    limit: null,
    delayMs: 500,
    dryRun: false,
    useAppApi: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (arg === "--music-dir" && next) {
      options.musicDir = next;
      index += 1;
    } else if (arg === "--region" && next) {
      options.region = next.toUpperCase();
      index += 1;
    } else if (arg === "--quality" && (next === "cd" || next === "hires48" || next === "max")) {
      options.qualityProfile = next;
      index += 1;
    } else if (
      arg === "--provider" &&
      (next === "auto" || next === "qobuz" || next === "tidal" || next === "amazon")
    ) {
      options.provider = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      const parsed = Number(next);
      options.limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
      index += 1;
    } else if (arg === "--delay-ms" && next) {
      const parsed = Number(next);
      options.delayMs = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : options.delayMs;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--use-app-api") {
      options.useAppApi = true;
    }
  }

  return options;
}

function normalizeTrackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function sanitizeFileSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
  return safe || "Unknown";
}

function truncateFileStem(stem: string, maxLength = 220): string {
  if (stem.length <= maxLength) return stem;
  return stem.slice(0, maxLength).trimEnd();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|timed out|temporarily|rate/i.test(message);
}

async function withRetries<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 15_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) break;
      await delay(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

async function collectFlacFiles(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFlacFiles(path, acc);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      acc.push(path);
    }
  }
  return acc;
}

function fallbackTitleArtistFromFile(path: string): { title: string; artist: string } {
  const stem = basename(path, extname(path));
  const dashIndex = stem.lastIndexOf(" - ");
  if (dashIndex > 0) {
    return {
      title: stem.slice(0, dashIndex).trim(),
      artist: stem.slice(dashIndex + 3).trim(),
    };
  }
  return { title: stem, artist: "Unknown Artist" };
}

async function readExistingTrackKeys(musicDir: string): Promise<Set<string>> {
  const files = await collectFlacFiles(musicDir);
  const keys = new Set<string>();
  for (const file of files) {
    const fallback = fallbackTitleArtistFromFile(file);
    try {
      const metadata = await parseFile(file, { skipCovers: true, duration: false });
      const title = metadata.common.title?.trim() || fallback.title;
      const artist =
        metadata.common.artist?.trim() ||
        metadata.common.artists?.find((value) => value.trim())?.trim() ||
        fallback.artist;
      keys.add(normalizeTrackKey(title, artist));
    } catch {
      keys.add(normalizeTrackKey(fallback.title, fallback.artist));
    }
  }
  return keys;
}

class CookieJar {
  private cookies = new Map<string, string>();

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  ingest(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? splitSetCookieHeader(headers.get("set-cookie"));
    for (const value of values) {
      const [pair] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,]+=)/g).map((entry) => entry.trim());
}

async function apiFetch(
  jar: CookieJar,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  jar.ingest(response);
  return response;
}

async function ensureApiSession(options: Options): Promise<CookieJar> {
  const jar = new CookieJar();
  const session = await apiFetch(jar, options.baseUrl, "/api/auth/session").catch((error) => {
    throw new Error(`Could not reach ${options.baseUrl}. Start the app on port 5174 first. ${error}`);
  });
  if (session.ok) {
    const payload = (await session.json().catch(() => ({}))) as { user?: unknown };
    if (payload.user) return jar;
  }

  const password = `Bulk-${randomBytes(12).toString("hex")}`;
  const email = `bulk-${Date.now()}-${randomBytes(3).toString("hex")}@local.test`;
  const register = await apiFetch(jar, options.baseUrl, "/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bulk Downloader", email, password }),
  });
  if (!register.ok) {
    const data = (await register.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Register failed with ${register.status}`);
  }

  const signin = await apiFetch(jar, options.baseUrl, "/api/auth/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) {
    const data = (await signin.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Sign in failed with ${signin.status}`);
  }
  return jar;
}

async function fetchTrackMetadata(
  jar: CookieJar,
  options: Options,
  trackId: string,
): Promise<SpotifyTrack> {
  const response = await apiFetch(jar, options.baseUrl, "/api/songs/spotify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "fetch",
      spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      region: options.region,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; track?: SpotifyTrack };
  if (!response.ok || !payload.track) {
    throw new Error(payload.error || `Metadata fetch failed with ${response.status}`);
  }
  return payload.track;
}

function extensionFromResponse(response: Response): string {
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] || "";
  const fileExt = extname(fileName).toLowerCase();
  if (fileExt) return fileExt;
  const type = response.headers.get("content-type")?.toLowerCase() || "";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  return ".flac";
}

async function transcodeToFlac(sourcePath: string, targetPath: string, track: SpotifyTrack): Promise<void> {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-map_metadata",
    "-1",
    "-metadata",
    `title=${track.title}`,
    "-metadata",
    `artist=${track.artist}`,
    "-metadata",
    `album=${track.album || ""}`,
    "-compression_level",
    "8",
    targetPath,
  ];
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 });
}

async function decryptAudio(sourcePath: string, targetPath: string, decryptionKey: string): Promise<void> {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-decryption_key",
    decryptionKey,
    "-i",
    sourcePath,
    "-c",
    "copy",
    targetPath,
  ];
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 });
}

function tempFileBase(track: SpotifyTrack): string {
  return `.${createHash("sha256")
    .update(`${track.spotifyId}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16)}.tmp`;
}

async function writeResponseAudioToFlac(
  response: Response,
  options: Options,
  track: SpotifyTrack,
  targetPath: string,
): Promise<void> {
  const sourceExt = extensionFromResponse(response);
  const tempName = tempFileBase(track);
  const tempPath = join(options.musicDir, sourceExt === ".flac" ? `${tempName}.flac` : `${tempName}${sourceExt || ".audio"}`);
  const tempFlacPath = sourceExt === ".flac" ? tempPath : join(options.musicDir, `${tempName}.flac`);
  await Bun.write(tempPath, await response.arrayBuffer());
  try {
    if (sourceExt !== ".flac") {
      await transcodeToFlac(tempPath, tempFlacPath, track);
      await unlink(tempPath).catch(() => undefined);
    }
    await rename(tempFlacPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    await unlink(tempFlacPath).catch(() => undefined);
    throw error;
  }
}

function extensionFromAmazonCodec(codec: string): string {
  return codec.trim().toLowerCase() === "flac" ? ".flac" : ".m4a";
}

async function writeAmazonStreamToFlac(
  stream: AmazonStream,
  options: Options,
  track: SpotifyTrack,
  targetPath: string,
): Promise<void> {
  const response = await fetch(stream.streamUrl, {
    redirect: "follow",
    headers: stream.headers,
  });
  if (!response.ok) {
    throw new Error(`Amazon audio server returned ${response.status}`);
  }

  const tempName = tempFileBase(track);
  const encryptedPath = join(options.musicDir, `${tempName}.amazon.enc`);
  const sourceExt = extensionFromAmazonCodec(stream.codec);
  const sourcePath = stream.decryptionKey
    ? join(options.musicDir, `${tempName}.amazon${sourceExt}`)
    : encryptedPath;
  const tempFlacPath = sourceExt === ".flac" ? sourcePath : join(options.musicDir, `${tempName}.flac`);

  await Bun.write(encryptedPath, await response.arrayBuffer());
  try {
    if (stream.decryptionKey) {
      await decryptAudio(encryptedPath, sourcePath, stream.decryptionKey);
      await unlink(encryptedPath).catch(() => undefined);
    }
    if (sourceExt !== ".flac") {
      await transcodeToFlac(sourcePath, tempFlacPath, track);
      await unlink(sourcePath).catch(() => undefined);
    }
    await rename(tempFlacPath, targetPath);
  } catch (error) {
    await unlink(encryptedPath).catch(() => undefined);
    await unlink(sourcePath).catch(() => undefined);
    await unlink(tempFlacPath).catch(() => undefined);
    throw error;
  }
}

async function downloadTrack(
  jar: CookieJar | null,
  options: Options,
  track: SpotifyTrack,
): Promise<string> {
  const stem = truncateFileStem(sanitizeFileSegment(`${track.title} - ${track.artist}`));
  const targetPath = join(options.musicDir, `${stem}.flac`);
  try {
    await stat(targetPath);
    return targetPath;
  } catch {}

  if (!jar) {
    return await downloadDirectTrack(options, track, targetPath);
  }

  if (options.provider === "amazon") {
    throw new Error("Amazon provider requires direct local mode; omit --use-app-api");
  }

  const payload: Record<string, string> = {
    mode: "spotify",
    spotifyUrl: `https://open.spotify.com/track/${track.spotifyId}`,
    region: options.region,
    title: track.title,
    artist: track.artist,
    album: track.album || "",
    durationMs: String(track.durationMs || ""),
    imageUrl: track.imageUrl || "",
    qualityProfile: options.qualityProfile,
  };
  if (options.provider !== "auto") payload.service = options.provider;

  const response = await apiFetch(jar, options.baseUrl, "/api/songs/spotify/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Audio download failed with ${response.status}`);
  }
  await writeResponseAudioToFlac(response, options, track, targetPath);
  return targetPath;
}

function printProgress(message: string): void {
  process.stdout.write(`${message}\n`);
}

function trackFromBatchTrack(track: SpotifyBatchTrack): SpotifyTrack {
  return {
    spotifyId: track.id,
    title: track.name,
    artist: track.artists.join(", "),
    album: "",
    durationMs: 0,
    imageUrl: "",
  };
}

function qualityLists(profile: Options["qualityProfile"]) {
  return {
    qobuz: profile === "cd" ? ["6"] : profile === "hires48" ? ["7", "6"] : ["27", "7", "6"],
    tidal: profile === "cd" ? ["LOSSLESS"] : ["HI_RES_LOSSLESS", "LOSSLESS"],
  };
}

type StreamProvider = "qobuz" | "tidal";

async function resolveProviderStreamUrl(options: Options, track: SpotifyTrack): Promise<string> {
  const qualities = qualityLists(options.qualityProfile);
  const qobuzErrors: string[] = [];
  const tidalErrors: string[] = [];

  if (options.provider === "auto" || options.provider === "qobuz") {
    for (const quality of qualities.qobuz) {
      try {
        return await resolveQobuzStreamUrl({
          title: track.title,
          artist: track.artist,
          album: track.album,
          quality,
        });
      } catch (error) {
        qobuzErrors.push(error instanceof Error ? error.message : `Qobuz ${quality} failed`);
      }
    }
    if (options.provider === "qobuz") {
      throw new Error(`No Qobuz stream found: ${qobuzErrors.join(" | ")}`);
    }
  }

  if (options.provider === "auto" || options.provider === "tidal") {
    for (const quality of qualities.tidal) {
      try {
        return await resolveTidalStreamUrl({
          title: track.title,
          artist: track.artist,
          album: track.album,
          quality,
        });
      } catch (error) {
        tidalErrors.push(error instanceof Error ? error.message : `Tidal ${quality} failed`);
      }
    }
    if (options.provider === "tidal") {
      throw new Error(`No Tidal stream found: ${tidalErrors.join(" | ")}`);
    }
  }

  throw new Error(
    `No downloadable provider found. Qobuz: ${qobuzErrors.join(" | ")}. Tidal: ${tidalErrors.join(" | ")}`,
  );
}

async function fetchDirectProviderAudio(
  options: Options,
  track: SpotifyTrack,
  provider?: StreamProvider,
): Promise<Response> {
  const streamUrl = await resolveProviderStreamUrl(
    provider ? { ...options, provider } : options,
    track,
  );
  const response = await fetch(streamUrl, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Audio server returned ${response.status}`);
  }
  return response;
}

async function downloadDirectTrack(
  options: Options,
  track: SpotifyTrack,
  targetPath: string,
): Promise<string> {
  const errors: Record<"qobuz" | "tidal" | "amazon", string[]> = {
    qobuz: [],
    tidal: [],
    amazon: [],
  };
  const streamProviders: StreamProvider[] =
    options.provider === "auto"
      ? ["qobuz", "tidal"]
      : options.provider === "qobuz" || options.provider === "tidal"
        ? [options.provider]
        : [];

  for (const provider of streamProviders) {
    try {
      const response = await fetchDirectProviderAudio(options, track, provider);
      await writeResponseAudioToFlac(response, options, track, targetPath);
      return targetPath;
    } catch (error) {
      errors[provider].push(error instanceof Error ? error.message : `${provider} failed`);
    }
  }

  if (options.provider === "auto" || options.provider === "amazon") {
    try {
      const stream = await resolveAmazonStreamUrl({
        spotifyId: track.spotifyId,
        region: options.region,
      });
      await writeAmazonStreamToFlac(stream, options, track, targetPath);
      return targetPath;
    } catch (error) {
      errors.amazon.push(error instanceof Error ? error.message : "Amazon failed");
    }
  }

  if (options.provider === "qobuz") throw new Error(`No Qobuz stream found: ${errors.qobuz.join(" | ")}`);
  if (options.provider === "tidal") throw new Error(`No Tidal stream found: ${errors.tidal.join(" | ")}`);
  if (options.provider === "amazon") throw new Error(`No Amazon stream found: ${errors.amazon.join(" | ")}`);
  throw new Error(
    `No downloadable provider found. Qobuz: ${errors.qobuz.join(" | ")}. Tidal: ${errors.tidal.join(" | ")}. Amazon: ${errors.amazon.join(" | ")}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const spotifyCookie = process.env.SPOTIFY_SP_DC?.trim();
  if (!spotifyCookie) {
    throw new Error("Set SPOTIFY_SP_DC to your current Spotify sp_dc value. The script never writes it to disk.");
  }

  await mkdir(options.musicDir, { recursive: true });
  printProgress(`Music folder: ${options.musicDir}`);
  const existingKeys = await readExistingTrackKeys(options.musicDir);
  printProgress(`Existing local FLAC keys: ${existingKeys.size}`);

  const liked = await fetchSpotifyLikedTracks(spotifyCookie, 10_000);
  const selectedTracks = options.limit === null ? liked.tracks : liked.tracks.slice(0, options.limit);
  printProgress(`Spotify Liked Songs: ${liked.tracks.length}`);
  if (options.limit !== null) printProgress(`Limit: ${options.limit}`);
  if (options.dryRun) return;

  const jar = options.useAppApi ? await ensureApiSession(options) : null;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let index = 0; index < selectedTracks.length; index += 1) {
    const batchTrack = selectedTracks[index];
    const prefix = `[${index + 1}/${selectedTracks.length}]`;
    try {
      const track = jar
        ? await withRetries(() => fetchTrackMetadata(jar, options, batchTrack.id))
        : trackFromBatchTrack(batchTrack);
      const key = normalizeTrackKey(track.title, track.artist);
      if (existingKeys.has(key)) {
        skipped += 1;
        printProgress(`${prefix} skip ${track.artist} - ${track.title}`);
        continue;
      }

      const path = await withRetries(() => downloadTrack(jar, options, track), {
        attempts: 2,
        baseDelayMs: 20_000,
      });
      existingKeys.add(key);
      downloaded += 1;
      printProgress(`${prefix} saved ${basename(path)}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Unknown error";
      failures.push(`${batchTrack.id}: ${message}`);
      printProgress(`${prefix} failed ${batchTrack.id}: ${message}`);
    }

    if (options.delayMs > 0) await delay(options.delayMs);
  }

  printProgress(`Done: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (failures.length > 0) {
    printProgress("Failures:");
    for (const failure of failures) printProgress(`- ${failure}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
