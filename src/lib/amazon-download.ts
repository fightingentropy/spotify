import { createDecipheriv, createHash } from "node:crypto";

// Amazon resolver flow adapted from SpotiFLAC 0.6.0's MIT-licensed Amazon provider.
// See THIRD_PARTY_NOTICES.md for the license notice.
const AMAZON_RESOLVE_URL = "https://api.zarz.moe/v1/resolve";
const AMAZON_ZARZ_MEDIA_URL = "https://api.zarz.moe/v1/dl/amazeamazeamaze/media";
const AMAZON_SPOTBYE1_API_URL = "https://amz.spotbye.qzz.io/api/track";
const AMAZON_SPOTBYE2_API_BASE_URL = "https://amazon.spotbye.qzz.io/api/track";
const SONG_LINK_API_URL = "https://api.song.link/v1-alpha.1/links";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SPOTIFLAC_MOBILE_USER_AGENT = "SpotiFLAC-Mobile/1.0";
const AMAZON_REQUEST_TIMEOUT_MS = 45_000;

const amazonDebugKeySeedParts = [
  Buffer.from("spotif"),
  Buffer.from("lac:am"),
  Buffer.from("azon:spotbye:api:v1"),
];
const amazonDebugKeyAAD = Buffer.from([
  0x61, 0x6d, 0x61, 0x7a, 0x6f, 0x6e, 0x7c, 0x73, 0x70, 0x6f, 0x74, 0x62,
  0x79, 0x65, 0x7c, 0x64, 0x65, 0x62, 0x75, 0x67, 0x7c, 0x76, 0x31,
]);
const amazonDebugKeyNonce = Buffer.from([
  0x52, 0x1f, 0xa4, 0x9c, 0x13, 0x77, 0x5b, 0xe2, 0x81, 0x44, 0x90, 0x6d,
]);
const amazonDebugKeyCiphertext = Buffer.from([
  0x5b, 0xf9, 0xc1, 0x2e, 0x58, 0xf8, 0x5b, 0xc0, 0x04, 0x68, 0x7e, 0xff,
  0x3d, 0xd6, 0x8b, 0xe3, 0x86, 0x49, 0x6c, 0xfd, 0xc1, 0x49, 0x0b, 0xfb,
]);
const amazonDebugKeyTag = Buffer.from([
  0x6c, 0x21, 0x98, 0x51, 0xf2, 0x38, 0x4b, 0x4a, 0x23, 0xe1, 0xc6, 0xd7,
  0x65, 0x7f, 0xfb, 0xa1,
]);

type JsonObject = Record<string, unknown>;

export type AmazonStream = {
  asin: string;
  provider: "zarz" | "spotbye1" | "spotbye2";
  streamUrl: string;
  decryptionKey: string;
  codec: string;
  headers: Record<string, string>;
  metadata: JsonObject;
};

export class AmazonDownloadError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

let amazonDebugKey: string | null = null;

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function amazonDebugHeaderValue(): string {
  if (amazonDebugKey) return amazonDebugKey;
  const key = createHash("sha256").update(Buffer.concat(amazonDebugKeySeedParts)).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, amazonDebugKeyNonce);
  decipher.setAAD(amazonDebugKeyAAD);
  decipher.setAuthTag(amazonDebugKeyTag);
  amazonDebugKey = Buffer.concat([
    decipher.update(amazonDebugKeyCiphertext),
    decipher.final(),
  ]).toString("utf8");
  return amazonDebugKey;
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
    options?.timeoutMs ?? AMAZON_REQUEST_TIMEOUT_MS,
  );
  const headers = new Headers(options?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT);
  if (!headers.has("accept")) headers.set("accept", "application/json, text/plain, */*");

  try {
    return await fetch(url, {
      method: options?.method ?? "GET",
      body: options?.body,
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AmazonDownloadError("Amazon provider request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonObject(response: Response): Promise<JsonObject> {
  const payload = await response.json().catch(() => null);
  if (Array.isArray(payload)) return toObject(payload[0]) ?? {};
  return toObject(payload) ?? {};
}

function amazonAsinFromUrl(value: string): string {
  const decoded = decodeURIComponent(value);
  return (
    decoded.match(/(?:trackAsin=|tracks\/)([A-Z0-9]{10})/)?.[1] ??
    decoded.match(/\b(B[0-9A-Z]{9})\b/)?.[1] ??
    ""
  );
}

function amazonUrlFromSongUrls(songUrls: unknown): string {
  const urls = toObject(songUrls);
  const value = urls?.AmazonMusic ?? urls?.amazonMusic;
  if (Array.isArray(value)) return toStringValue(value.find((entry) => toStringValue(entry)));
  return toStringValue(value);
}

async function resolveAmazonAsinViaZarz(spotifyId: string): Promise<string> {
  const response = await fetchWithTimeout(AMAZON_RESOLVE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": SPOTIFLAC_MOBILE_USER_AGENT,
    },
    body: JSON.stringify({ url: `https://open.spotify.com/track/${spotifyId}` }),
    timeoutMs: 20_000,
  });
  if (!response.ok) throw new AmazonDownloadError(`Zarz resolve returned ${response.status}`, response.status);
  const payload = await readJsonObject(response);
  const amazonUrl = amazonUrlFromSongUrls(payload.songUrls);
  const asin = amazonAsinFromUrl(amazonUrl);
  if (!asin) throw new AmazonDownloadError("Zarz resolve returned no Amazon Music ASIN", 404);
  return asin;
}

async function resolveAmazonAsinViaSongLink(spotifyId: string, region: string): Promise<string> {
  const url = new URL(SONG_LINK_API_URL);
  url.searchParams.set("url", `https://open.spotify.com/track/${spotifyId}`);
  url.searchParams.set("userCountry", region || "US");
  const response = await fetchWithTimeout(url.toString(), { timeoutMs: 20_000 });
  if (!response.ok) throw new AmazonDownloadError(`Song.link returned ${response.status}`, response.status);
  const payload = await readJsonObject(response);
  const links = toObject(payload.linksByPlatform);
  const amazonMusic = toObject(links?.amazonMusic);
  const asin = amazonAsinFromUrl(toStringValue(amazonMusic?.url));
  if (!asin) throw new AmazonDownloadError("Song.link returned no Amazon Music ASIN", 404);
  return asin;
}

async function resolveAmazonAsinViaSongLinkHtml(spotifyId: string): Promise<string> {
  const response = await fetchWithTimeout(`https://song.link/s/${spotifyId}`, {
    headers: { "user-agent": DEFAULT_USER_AGENT, accept: "text/html,*/*" },
    timeoutMs: 20_000,
  });
  if (!response.ok) throw new AmazonDownloadError(`Song.link page returned ${response.status}`, response.status);
  const html = await response.text();
  const asin =
    html.match(/trackAsin=([A-Z0-9]{10})/)?.[1] ??
    html.match(/https:\/\/music\.amazon\.com\/tracks\/([A-Z0-9]{10})/)?.[1] ??
    "";
  if (!asin) throw new AmazonDownloadError("Song.link page contained no Amazon Music ASIN", 404);
  return asin;
}

async function resolveAmazonAsin(spotifyId: string, region: string): Promise<string> {
  const errors: string[] = [];
  for (const resolver of [
    () => resolveAmazonAsinViaZarz(spotifyId),
    () => resolveAmazonAsinViaSongLink(spotifyId, region),
    () => resolveAmazonAsinViaSongLinkHtml(spotifyId),
  ]) {
    try {
      return await resolver();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Amazon ASIN resolver failed");
    }
  }
  throw new AmazonDownloadError(`Could not resolve Amazon Music ASIN: ${errors.join(" | ")}`, 404);
}

async function resolveZarzAmazonStream(asin: string): Promise<AmazonStream> {
  const url = new URL(AMAZON_ZARZ_MEDIA_URL);
  url.searchParams.set("asin", asin);
  url.searchParams.set("codec", "flac");
  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      accept: "application/json",
      "user-agent": SPOTIFLAC_MOBILE_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new AmazonDownloadError(`Zarz media returned ${response.status}`, response.status);
  }
  const payload = await readJsonObject(response);
  const audio = toObject(payload.audio);
  const streamUrl = toStringValue(audio?.url);
  if (!streamUrl) throw new AmazonDownloadError("Zarz media returned no stream URL", 502);
  return {
    asin,
    provider: "zarz",
    streamUrl,
    decryptionKey: toStringValue(audio?.key),
    codec: toStringValue(audio?.codec) || "flac",
    headers: { "user-agent": SPOTIFLAC_MOBILE_USER_AGENT },
    metadata: toObject(payload.metadata) ?? {},
  };
}

async function resolveSpotbye1AmazonStream(asin: string): Promise<AmazonStream> {
  const response = await fetchWithTimeout(AMAZON_SPOTBYE1_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-debug-key": amazonDebugHeaderValue(),
    },
    body: JSON.stringify({ asin, tier: "best", country: "US" }),
  });
  if (!response.ok) {
    throw new AmazonDownloadError(`Spotbye1 returned ${response.status}`, response.status);
  }
  const payload = await readJsonObject(response);
  const stream = toObject(payload.stream);
  const drm = toObject(payload.drm);
  const streamUrl = toStringValue(stream?.url) || toStringValue(payload.streamUrl);
  if (!streamUrl) throw new AmazonDownloadError("Spotbye1 returned no stream URL", 502);
  const streamHeaders = toObject(stream?.headers);
  const captchaToken =
    toStringValue(streamHeaders?.["x-captcha-token"]) ||
    toStringValue(payload["x-captcha-token"]) ||
    toStringValue(payload.xCaptchaToken);
  const headers: Record<string, string> = { "user-agent": DEFAULT_USER_AGENT };
  if (captchaToken) headers["x-captcha-token"] = captchaToken;
  return {
    asin,
    provider: "spotbye1",
    streamUrl,
    decryptionKey: toStringValue(drm?.key) || toStringValue(payload.decryptionKey),
    codec: toStringValue(stream?.codec) || "flac",
    headers,
    metadata: toObject(payload.metadata) ?? {},
  };
}

async function resolveSpotbye2AmazonStream(asin: string): Promise<AmazonStream> {
  const response = await fetchWithTimeout(`${AMAZON_SPOTBYE2_API_BASE_URL}/${asin}`, {
    headers: {
      accept: "application/json",
      "x-debug-key": amazonDebugHeaderValue(),
    },
  });
  if (!response.ok) {
    throw new AmazonDownloadError(`Spotbye2 returned ${response.status}`, response.status);
  }
  const payload = await readJsonObject(response);
  const streamUrl = toStringValue(payload.streamUrl);
  if (!streamUrl) throw new AmazonDownloadError("Spotbye2 returned no stream URL", 502);
  const captchaToken = toStringValue(payload["x-captcha-token"]) || toStringValue(payload.xCaptchaToken);
  const headers: Record<string, string> = { "user-agent": DEFAULT_USER_AGENT };
  if (captchaToken) headers["x-captcha-token"] = captchaToken;
  return {
    asin,
    provider: "spotbye2",
    streamUrl,
    decryptionKey: toStringValue(payload.decryptionKey),
    codec: toStringValue(payload.codec) || "flac",
    headers,
    metadata: toObject(payload.metadata) ?? {},
  };
}

export async function resolveAmazonStreamUrl(options: {
  spotifyId: string;
  region?: string;
}): Promise<AmazonStream> {
  const asin = await resolveAmazonAsin(options.spotifyId, (options.region || "US").toUpperCase());
  const errors: string[] = [];
  for (const resolver of [
    () => resolveZarzAmazonStream(asin),
    () => resolveSpotbye1AmazonStream(asin),
    () => resolveSpotbye2AmazonStream(asin),
  ]) {
    try {
      return await resolver();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Amazon stream resolver failed");
    }
  }
  throw new AmazonDownloadError(`No Amazon stream found for ${asin}: ${errors.join(" | ")}`, 502);
}
