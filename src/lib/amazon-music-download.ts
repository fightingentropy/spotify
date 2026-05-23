import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const AMAZON_MUSIC_API_BASE_URL = "https://amazon.spotbye.qzz.io";
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOADER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const amazonAlbumTrackPath = /\/albums\/[A-Z0-9]{10}\/(B[0-9A-Z]{9})/i;
const amazonTrackPath = /\/tracks\/(B[0-9A-Z]{9})/i;

const amazonMusicDebugKeySeedParts = [
  Buffer.from("spotif"),
  Buffer.from("lac:am"),
  Buffer.from("azon:spotbye:api:v1"),
];
const amazonMusicDebugKeyAAD = Buffer.from([
  0x61, 0x6d, 0x61, 0x7a, 0x6f, 0x6e, 0x7c, 0x73, 0x70, 0x6f, 0x74, 0x62,
  0x79, 0x65, 0x7c, 0x64, 0x65, 0x62, 0x75, 0x67, 0x7c, 0x76, 0x31,
]);
const amazonMusicDebugKeyNonce = Buffer.from([
  0x52, 0x1f, 0xa4, 0x9c, 0x13, 0x77, 0x5b, 0xe2, 0x81, 0x44, 0x90, 0x6d,
]);
const amazonMusicDebugKeyCiphertext = Buffer.from([
  0x5b, 0xf9, 0xc1, 0x2e, 0x58, 0xf8, 0x5b, 0xc0, 0x04, 0x68, 0x7e, 0xff,
  0x3d, 0xd6, 0x8b, 0xe3, 0x86, 0x49, 0x6c, 0xfd, 0xc1, 0x49, 0x0b, 0xfb,
]);
const amazonMusicDebugKeyTag = Buffer.from([
  0x6c, 0x21, 0x98, 0x51, 0xf2, 0x38, 0x4b, 0x4a, 0x23, 0xe1, 0xc6, 0xd7,
  0x65, 0x7f, 0xfb, 0xa1,
]);

let amazonMusicDebugKey: string | null = null;

export type AmazonMusicSource = {
  service: "amazon";
  asin: string;
  streamUrl: string;
  decryptionKey: string;
  fileNameHint: string;
  contentType: string;
};

export type OpenedAmazonMusicAudio = {
  stream: Readable;
  contentType: string;
  fileNameHint: string;
  extension: string;
  size?: number;
  cleanup: () => Promise<void>;
};

export class AmazonMusicDownloadError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function getAmazonMusicDebugKey(): string {
  if (amazonMusicDebugKey) return amazonMusicDebugKey;

  const hash = createHash("sha256");
  for (const part of amazonMusicDebugKeySeedParts) {
    hash.update(part);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    hash.digest(),
    amazonMusicDebugKeyNonce,
  );
  decipher.setAAD(amazonMusicDebugKeyAAD);
  decipher.setAuthTag(amazonMusicDebugKeyTag);

  amazonMusicDebugKey = Buffer.concat([
    decipher.update(amazonMusicDebugKeyCiphertext),
    decipher.final(),
  ]).toString("utf8");
  return amazonMusicDebugKey;
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

function extractAmazonAsin(rawUrl: string): string {
  const match = rawUrl.match(/\b(B[0-9A-Z]{9})\b/i);
  return match?.[1]?.toUpperCase() ?? "";
}

export function normalizeAmazonMusicUrl(rawUrl: string): string {
  const amazonUrl = rawUrl.trim();
  if (!amazonUrl) return "";

  try {
    const parsed = new URL(amazonUrl);
    const trackAsin = parsed.searchParams.get("trackAsin");
    if (trackAsin && /^B[0-9A-Z]{9}$/i.test(trackAsin)) {
      return `https://music.amazon.com/tracks/${trackAsin.toUpperCase()}?musicTerritory=US`;
    }
  } catch {}

  const albumTrackMatch = amazonUrl.match(amazonAlbumTrackPath);
  if (albumTrackMatch?.[1]) {
    return `https://music.amazon.com/tracks/${albumTrackMatch[1].toUpperCase()}?musicTerritory=US`;
  }

  const trackMatch = amazonUrl.match(amazonTrackPath);
  if (trackMatch?.[1]) {
    return `https://music.amazon.com/tracks/${trackMatch[1].toUpperCase()}?musicTerritory=US`;
  }

  const asin = extractAmazonAsin(amazonUrl);
  return asin ? `https://music.amazon.com/tracks/${asin}?musicTerritory=US` : "";
}

async function fetchWithTimeout(
  url: string,
  options?: { headers?: HeadersInit; timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const headers = new Headers(options?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_DOWNLOADER_USER_AGENT);
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/plain, */*");
  }

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AmazonMusicDownloadError("Amazon Music request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveAmazonMusicSource(amazonUrl: string): Promise<AmazonMusicSource> {
  const normalizedUrl = normalizeAmazonMusicUrl(amazonUrl);
  const asin = extractAmazonAsin(normalizedUrl);
  if (!asin) {
    throw new AmazonMusicDownloadError("Could not resolve Amazon Music track ID", 400);
  }

  const response = await fetchWithTimeout(`${AMAZON_MUSIC_API_BASE_URL}/api/track/${asin}`, {
    headers: {
      "X-Debug-Key": getAmazonMusicDebugKey(),
    },
  }).catch((error) => {
    if (error instanceof AmazonMusicDownloadError) throw error;
    throw new AmazonMusicDownloadError("Failed to reach Amazon Music resolver", 502);
  });

  if (!response.ok) {
    throw new AmazonMusicDownloadError(
      `Amazon Music resolver returned ${response.status}`,
      response.status >= 500 ? 502 : 400,
    );
  }

  const payload = toObject(await response.json().catch(() => null));
  const streamUrl = toStringValue(payload?.streamUrl);
  if (!streamUrl.startsWith("http")) {
    throw new AmazonMusicDownloadError("Amazon Music resolver returned no stream URL", 502);
  }

  return {
    service: "amazon",
    asin,
    streamUrl,
    decryptionKey: toStringValue(payload?.decryptionKey),
    fileNameHint: `${asin}.m4a`,
    contentType: "audio/mp4",
  };
}

function contentTypeForExtension(extension: string): string {
  if (extension === ".flac") return "audio/flac";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  return "audio/mp4";
}

function extensionFromResponse(response: Response, streamUrl: string, fallbackExt: string): string {
  try {
    const urlExt = new URL(streamUrl).pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
    if (urlExt) return urlExt;
  } catch {}

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("flac")) return ".flac";
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  if (contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac")) {
    return ".m4a";
  }
  return fallbackExt;
}

async function runProcess(command: string, args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new AmazonMusicDownloadError(`${label} failed: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const details = stderr.trim();
      reject(
        new AmazonMusicDownloadError(
          details ? `${label} exited with code ${code}: ${details}` : `${label} exited with code ${code}`,
          500,
        ),
      );
    });
  });
}

async function probeAudioCodec(inputPath: string): Promise<string> {
  return runProcess(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    "ffprobe",
  ).catch(() => "");
}

async function decryptAmazonFile(
  inputPath: string,
  outputPath: string,
  decryptionKey: string,
): Promise<void> {
  await runProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-decryption_key",
      decryptionKey.trim(),
      "-i",
      inputPath,
      "-c",
      "copy",
      "-y",
      outputPath,
    ],
    "ffmpeg decryption",
  );
}

export async function openAmazonMusicSource(
  source: AmazonMusicSource,
): Promise<OpenedAmazonMusicAudio> {
  const response = await fetchWithTimeout(source.streamUrl).catch((error) => {
    if (error instanceof AmazonMusicDownloadError) throw error;
    throw new AmazonMusicDownloadError("Failed to fetch Amazon Music stream", 502);
  });

  if (!response.ok || !response.body) {
    throw new AmazonMusicDownloadError(`Amazon Music stream returned ${response.status}`, 502);
  }

  if (!source.decryptionKey) {
    const extension = extensionFromResponse(response, source.streamUrl, ".m4a");
    const responseContentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    return {
      stream: Readable.fromWeb(response.body as unknown as WebReadableStream),
      contentType: responseContentType.includes("audio")
        ? responseContentType
        : contentTypeForExtension(extension),
      fileNameHint: `${source.asin}${extension}`,
      extension,
      cleanup: async () => {},
    };
  }

  let tempDir = "";
  try {
    tempDir = await mkdtemp(join(tmpdir(), "waveform-amazon-"));
    const encryptedPath = join(tempDir, `${source.asin}.m4a`);
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      createWriteStream(encryptedPath),
    );

    const codec = (await probeAudioCodec(encryptedPath)).toLowerCase();
    const extension = codec === "flac" ? ".flac" : ".m4a";
    const outputPath = join(tempDir, `${source.asin}${extension}`);
    await decryptAmazonFile(encryptedPath, outputPath, source.decryptionKey);
    const fileInfo = await stat(outputPath);

    return {
      stream: createReadStream(outputPath),
      contentType: contentTypeForExtension(extension),
      fileNameHint: `${source.asin}${extension}`,
      extension,
      size: fileInfo.size,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    if (error instanceof AmazonMusicDownloadError) throw error;
    throw new AmazonMusicDownloadError(
      error instanceof Error ? error.message : "Failed to prepare Amazon Music audio",
      502,
    );
  }
}
