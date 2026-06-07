const DEFAULT_USER_AGENT = "spotify/1.0 (+https://spotify.fightingentropy.org)";
const LICENSED_SOURCE_REQUEST_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type LicensedSourceStream = {
  kind: "url" | "dash";
  streamUrl: string;
  headers: Record<string, string>;
  contentType: string;
  metadata: JsonObject;
  dash?: LicensedSourceDash;
};

export type LicensedSourceDash = {
  manifestXml?: string;
  manifestUrl?: string;
};

export class LicensedSourceDownloadError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function readNestedObject(payload: JsonObject, key: string): JsonObject | null {
  return toObject(payload[key]);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = toStringValue(value);
    if (text) return text;
  }
  return "";
}

function headersFromValue(value: unknown): Record<string, string> {
  const headers = toObject(value);
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    const normalizedKey = key.trim().toLowerCase();
    const value = toStringValue(rawValue);
    if (!normalizedKey || !value) continue;
    out[normalizedKey] = value;
  }
  return out;
}

function decodeBase64Text(value: string): string {
  if (!value) return "";
  try {
    if (typeof atob === "function") {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  } catch {}
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function maybeManifestXml(value: unknown): string {
  const text = toStringValue(value);
  if (!text) return "";
  if (text.includes("<MPD")) return text;
  const decoded = decodeBase64Text(text);
  return decoded.includes("<MPD") ? decoded : "";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = LICENSED_SOURCE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LicensedSourceDownloadError("Licensed source provider timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveLicensedSourceStreamUrl(options: {
  endpointUrl: string;
  apiKey?: string;
  userAgent?: string;
  spotifyId: string;
  spotifyUrl: string;
  region?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: string;
  qualityProfile?: string;
  outputFormat?: string;
  body?: JsonObject;
  timeoutMs?: number;
}): Promise<LicensedSourceStream> {
  const endpoint = parseHttpUrl(options.endpointUrl);
  if (!endpoint) {
    throw new LicensedSourceDownloadError("Licensed source provider is not configured", 501);
  }

  const headers = new Headers({
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": options.userAgent || DEFAULT_USER_AGENT,
  });
  if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);

  const response = await fetchWithTimeout(endpoint.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {
      spotifyId: options.spotifyId,
      spotifyUrl: options.spotifyUrl,
      region: (options.region || "US").toUpperCase(),
      title: options.title || "",
      artist: options.artist || "",
      album: options.album || "",
      durationMs: options.durationMs || "",
      qualityProfile: options.qualityProfile || "max",
      outputFormat: options.outputFormat || "flac",
    }),
  }, options.timeoutMs);

  const text = await response.text();
  let payload: JsonObject = {};
  if (text.trim().startsWith("http://") || text.trim().startsWith("https://")) {
    payload = { streamUrl: text.trim() };
  } else {
    try {
      payload = toObject(JSON.parse(text || "{}")) ?? {};
    } catch {
      if (!response.ok) {
        throw new LicensedSourceDownloadError(
          `Licensed source provider returned ${response.status}`,
          response.status,
        );
      }
      throw new LicensedSourceDownloadError("Licensed source provider returned invalid JSON", 502);
    }
  }
  const audio = readNestedObject(payload, "audio") ?? {};
  const stream = readNestedObject(payload, "stream") ?? {};
  const data = readNestedObject(payload, "data") ?? {};
  const message = firstString(payload.error, payload.message, data.error, data.message);

  if (!response.ok) {
    throw new LicensedSourceDownloadError(
      message || `Licensed source provider returned ${response.status}`,
      response.status,
    );
  }

  const streamUrl = firstString(
    payload.streamUrl,
    payload.audioUrl,
    payload.downloadUrl,
    payload.url,
    data.streamUrl,
    data.audioUrl,
    data.downloadUrl,
    data.url,
    data.uri,
    data.manifestUrl,
    payload.mpdUri,
    audio.url,
    stream.url,
  );
  const parsedStreamUrl = parseHttpUrl(streamUrl);
  if (!parsedStreamUrl) {
    throw new LicensedSourceDownloadError("Licensed source provider returned no stream URL", 502);
  }
  const manifestXml = maybeManifestXml(data.manifest) || maybeManifestXml(payload.manifest);
  const contentType = firstString(payload.contentType, data.contentType, audio.contentType, stream.contentType);
  const looksLikeDash =
    Boolean(manifestXml) ||
    contentType.includes("dash") ||
    parsedStreamUrl.pathname.toLowerCase().endsWith(".mpd") ||
    firstString(data.manifestUrl, payload.mpdUri).startsWith("http");

  return {
    kind: looksLikeDash ? "dash" : "url",
    streamUrl: parsedStreamUrl.toString(),
    headers: {
      ...headersFromValue(payload.headers),
      ...headersFromValue(data.headers),
      ...headersFromValue(audio.headers),
      ...headersFromValue(stream.headers),
    },
    contentType,
    metadata: toObject(payload.metadata) ?? toObject(data.metadata) ?? {},
    dash: looksLikeDash
      ? {
          manifestXml,
          manifestUrl: firstString(data.manifestUrl, payload.mpdUri, data.uri, payload.uri, streamUrl),
        }
      : undefined,
  };
}

function xmlAttr(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}="([^"]+)"`));
  return match?.[1]?.replaceAll("&amp;", "&") ?? "";
}

function segmentUrlsFromManifest(manifestXml: string): string[] {
  const templateMatch = manifestXml.match(/<SegmentTemplate\b[\s\S]*?<\/SegmentTemplate>/);
  const template = templateMatch?.[0] ?? "";
  if (!template) throw new LicensedSourceDownloadError("Licensed source DASH manifest has no SegmentTemplate", 502);
  const initialization = xmlAttr(template, "initialization");
  const media = xmlAttr(template, "media");
  const startNumber = Number(xmlAttr(template, "startNumber") || "1");
  if (!initialization || !media || !Number.isFinite(startNumber)) {
    throw new LicensedSourceDownloadError("Licensed source DASH manifest is missing segment URLs", 502);
  }
  let segmentCount = 0;
  for (const match of template.matchAll(/<S\b([^>]*)\/>/g)) {
    const attrs = match[1] ?? "";
    const repeatRaw = attrs.match(/\br="(-?\d+)"/)?.[1];
    const repeat = repeatRaw ? Number(repeatRaw) : 0;
    if (!Number.isFinite(repeat) || repeat < 0) {
      throw new LicensedSourceDownloadError("Licensed source DASH manifest uses unsupported open-ended segments", 502);
    }
    segmentCount += repeat + 1;
  }
  if (segmentCount <= 0) throw new LicensedSourceDownloadError("Licensed source DASH manifest has no segments", 502);
  const urls = [initialization];
  for (let index = 0; index < segmentCount; index += 1) {
    urls.push(media.replaceAll("$Number$", String(startNumber + index)));
  }
  return urls;
}

async function readManifest(stream: LicensedSourceStream): Promise<string> {
  const inline = stream.dash?.manifestXml;
  if (inline) return inline;
  const manifestUrl = stream.dash?.manifestUrl || stream.streamUrl;
  const response = await fetchWithTimeout(manifestUrl, {
    method: "GET",
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      ...stream.headers,
    },
  });
  if (!response.ok) throw new LicensedSourceDownloadError(`Licensed source manifest returned ${response.status}`, response.status);
  const text = await response.text();
  if (!text.includes("<MPD")) throw new LicensedSourceDownloadError("Licensed source manifest is not DASH MPD", 502);
  return text;
}

export async function materializeLicensedSourceStream(
  stream: LicensedSourceStream,
  options?: { maxBytes?: number; userAgent?: string },
): Promise<Response> {
  if (stream.kind === "url") {
    return fetchWithTimeout(stream.streamUrl, {
      method: "GET",
      headers: {
        ...stream.headers,
        "user-agent": options?.userAgent || DEFAULT_USER_AGENT,
      },
    });
  }

  const manifestXml = await readManifest(stream);
  const segmentUrls = segmentUrlsFromManifest(manifestXml);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (const url of segmentUrls) {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        ...stream.headers,
        "user-agent": options?.userAgent || DEFAULT_USER_AGENT,
      },
    });
    if (!response.ok) throw new LicensedSourceDownloadError(`Licensed source segment returned ${response.status}`, response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (options?.maxBytes && totalBytes > options.maxBytes) {
      throw new LicensedSourceDownloadError("Licensed source audio is too large", 413);
    }
    chunks.push(bytes);
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(out, {
    headers: {
      "content-type": stream.contentType || "audio/mp4",
      "content-length": String(totalBytes),
    },
  });
}
