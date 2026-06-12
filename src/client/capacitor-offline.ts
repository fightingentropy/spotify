"use client";

import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

export type NativeOfflineAssetKind = "audio" | "image" | "lyrics";

export type NativeOfflineAsset = {
  kind: NativeOfflineAssetKind;
  originalUrl: string;
  path: string;
  uri: string;
  size: number;
  contentType?: string;
};

export type NativeOfflineFiles = Partial<Record<NativeOfflineAssetKind, NativeOfflineAsset>>;

const OFFLINE_ROOT = "offline-media";

export function isNativeOfflineStorageAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function safePathSegment(value: string): string {
  return encodeURIComponent(value.trim() || "unknown").replace(/%/g, "_").slice(0, 96);
}

function extensionFromUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue, location.origin);
    const match = url.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return `.${match[1].toLowerCase()}`;
  } catch {}
  return "";
}

function extensionForAsset(kind: NativeOfflineAssetKind, url: string, blob: Blob): string {
  const fromUrl = extensionFromUrl(url);
  if (fromUrl) return fromUrl;
  const type = blob.type.toLowerCase();
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return ".m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("flac")) return ".flac";
  if (type.includes("wav")) return ".wav";
  if (kind === "lyrics") return ".lrc";
  if (kind === "image") return ".jpg";
  return ".bin";
}

// Magic-number sniff for the image formats the app serves. Catches the classic
// poisoning case where an HTTP error body (JSON/HTML) gets persisted as a
// cover image: those bytes start with '{' or '<', never a valid image header.
export function looksLikeImageBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return true;
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return true;
  return false;
}

async function blobHeadBytes(blob: Blob, length = 16): Promise<Uint8Array> {
  const head = blob.slice(0, length);
  return new Uint8Array(await head.arrayBuffer());
}

export async function assertValidImageBlob(blob: Blob): Promise<void> {
  if (blob.size <= 0) throw new Error("Downloaded cover image is empty");
  if (!looksLikeImageBytes(await blobHeadBytes(blob))) {
    throw new Error("Downloaded cover image is not a valid image");
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read native download"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

// Chunk size for streaming base64 appends. ~4MB of binary -> ~5.3MB base64, keeping
// peak memory bounded instead of holding the whole (100MB+) file in one string.
const NATIVE_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value, location.origin);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Write a large blob to disk in base64 chunks so we never materialize the entire
// file (and its larger base64 representation) in memory at once.
async function writeBlobInChunks(path: string, blob: Blob): Promise<void> {
  let offset = 0;
  let first = true;
  while (offset < blob.size) {
    const slice = blob.slice(offset, Math.min(offset + NATIVE_APPEND_CHUNK_BYTES, blob.size));
    const data = await blobToBase64(slice);
    if (first) {
      await Filesystem.writeFile({ directory: Directory.Data, path, data, recursive: true });
      first = false;
    } else {
      await Filesystem.appendFile({ directory: Directory.Data, path, data });
    }
    offset += NATIVE_APPEND_CHUNK_BYTES;
  }
  if (first) {
    // Empty blob: still create the (empty) file so callers see a consistent result.
    await Filesystem.writeFile({ directory: Directory.Data, path, data: "", recursive: true });
  }
}

async function resolveNativeFileUri(path: string): Promise<{ uri: string; size: number | null }> {
  const stat = await Filesystem.stat({ directory: Directory.Data, path }).catch(() => null);
  if (stat?.uri) {
    return { uri: stat.uri, size: typeof stat.size === "number" ? stat.size : null };
  }
  const result = await Filesystem.getUri({ directory: Directory.Data, path });
  return { uri: result.uri, size: null };
}

export function nativeOfflineAssetWebUrl(asset: NativeOfflineAsset | null | undefined): string | null {
  if (!asset?.uri) return null;
  try {
    return Capacitor.convertFileSrc(asset.uri);
  } catch {
    return asset.uri;
  }
}

export function isCapacitorFileUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes("/_capacitor_file_/");
}

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
};
const DEFAULT_OFFLINE_AUDIO_MIME = "audio/flac";

function offlineAudioMime(url: string, contentType?: string): string {
  const stored = (contentType ?? "").trim().toLowerCase();
  if (stored && stored !== "application/octet-stream") return stored;
  const match = url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const extension = match ? match[1].toLowerCase() : "";
  return AUDIO_MIME_BY_EXTENSION[extension] ?? DEFAULT_OFFLINE_AUDIO_MIME;
}

// WKWebView's scheme handler answers non-Range requests without headers, so it
// marks _capacitor_file_ media non-byte-range-accessible and silently drops
// seeks. Materializing the file as a typed Blob (blob: URLs are inherently
// seekable in WebKit) is what makes native offline seeking work at all.
export async function fetchNativeOfflineAudioBlob(url: string, contentType?: string): Promise<Blob> {
  const response = await fetch(url);
  // iOS answers non-Range media requests with a bare URLResponse, which WebKit
  // surfaces as status 0 — that's a successful read, not a failure. (Don't force
  // the Range path instead: it reads the whole tail synchronously on the iOS
  // main thread, freezing the UI for large FLACs.)
  if (!response.ok && response.status !== 0) {
    throw new Error(`Native offline audio read failed (${response.status})`);
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("Native offline audio read returned no data");
  const type = blob.type.trim().toLowerCase();
  if (type && type !== "application/octet-stream") return blob;
  return new Blob([blob], { type: offlineAudioMime(url, contentType) });
}

// Object URLs pin their entire Blob in memory (hi-res FLACs run 100-300MB), so
// aggressive revocation is load-bearing: with the dual-element crossfade at
// most two entries may ever be alive at once.
const nativeOfflineAudioObjectUrls = new Map<string, string>();

export async function acquireNativeOfflineAudioObjectUrl(src: string, contentType?: string): Promise<string> {
  const cached = nativeOfflineAudioObjectUrls.get(src);
  if (cached) return cached;
  const blob = await fetchNativeOfflineAudioBlob(src, contentType);
  // A concurrent acquire may have landed while the blob was being read.
  const raced = nativeOfflineAudioObjectUrls.get(src);
  if (raced) return raced;
  const objectUrl = URL.createObjectURL(blob);
  nativeOfflineAudioObjectUrls.set(src, objectUrl);
  return objectUrl;
}

export function releaseNativeOfflineAudioObjectUrl(src: string): void {
  const objectUrl = nativeOfflineAudioObjectUrls.get(src);
  if (!objectUrl) return;
  nativeOfflineAudioObjectUrls.delete(src);
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {}
}

export async function saveNativeOfflineAsset(options: {
  songId: string;
  kind: NativeOfflineAssetKind;
  url: string;
  blob: Blob;
}): Promise<NativeOfflineAsset | null> {
  if (!isNativeOfflineStorageAvailable()) return null;

  const path = [
    OFFLINE_ROOT,
    safePathSegment(options.songId),
    `${options.kind}${extensionForAsset(options.kind, options.url, options.blob)}`,
  ].join("/");
  const baseAsset = {
    kind: options.kind,
    originalUrl: options.url,
    path,
    contentType: options.blob.type || undefined,
  };

  // The caller's blob came from a response.ok-checked fetch; trust it as the
  // integrity reference. Filesystem.downloadFile below performs its own
  // unauthenticated native request and saves whatever comes back — including
  // 4xx/5xx error bodies — so it must never be the only validation layer.
  if (options.kind === "image") {
    await assertValidImageBlob(options.blob);
  }

  const absoluteUrl =
    options.kind === "audio" && isAbsoluteHttpUrl(options.url)
      ? new URL(options.url, location.origin).toString()
      : null;

  // 1) Audio only: stream straight from the URL to disk so the whole file never
  //    lives in JS memory twice. Cross-check the written size against the
  //    validated blob — a mismatch means downloadFile saved an error body.
  if (absoluteUrl) {
    try {
      await Filesystem.downloadFile({ url: absoluteUrl, directory: Directory.Data, path, recursive: true });
      const resolved = await resolveNativeFileUri(path);
      if (
        typeof resolved.size === "number" &&
        options.blob.size > 0 &&
        resolved.size !== options.blob.size
      ) {
        throw new Error("Native download size mismatch");
      }
      return { ...baseAsset, uri: resolved.uri, size: resolved.size ?? options.blob.size };
    } catch {
      // Fall through to writing from the validated in-hand blob.
    }
  }

  // 2) Chunked append from the already-downloaded blob: peak memory stays ~one chunk.
  try {
    await writeBlobInChunks(path, options.blob);
    const resolved = await resolveNativeFileUri(path);
    return { ...baseAsset, uri: resolved.uri, size: resolved.size ?? options.blob.size };
  } catch {
    // Fall through to the single-shot base64 write.
  }

  // 3) Last resort: encode the whole blob at once (legacy behaviour).
  const data = await blobToBase64(options.blob);
  const result = await Filesystem.writeFile({
    directory: Directory.Data,
    path,
    data,
    recursive: true,
  });
  return { ...baseAsset, uri: result.uri, size: options.blob.size };
}

export async function verifyNativeOfflineAsset(
  asset: NativeOfflineAsset | null | undefined,
): Promise<boolean> {
  if (!isNativeOfflineStorageAvailable() || !asset?.path) return false;
  try {
    const stat = await Filesystem.stat({
      directory: Directory.Data,
      path: asset.path,
    });
    if (typeof stat.size === "number" && stat.size <= 0) return false;

    // Size alone can't catch a persisted HTTP error body (historic downloads
    // used Filesystem.downloadFile, which saves 4xx/5xx responses verbatim).
    // Images are small enough to read back and sniff, and a poisoned cover is
    // exactly the corruption users see, so deep-check those.
    if (asset.kind === "image") {
      const webUrl = nativeOfflineAssetWebUrl(asset);
      if (!webUrl) return false;
      const response = await fetch(webUrl);
      // The WKWebView scheme handler answers local file reads with status 0.
      if (!response.ok && response.status !== 0) return false;
      const blob = await response.blob();
      if (blob.size <= 0) return false;
      return looksLikeImageBytes(await blobHeadBytes(blob));
    }

    return true;
  } catch {
    return false;
  }
}

export async function deleteNativeOfflineFiles(files: NativeOfflineFiles | null | undefined): Promise<void> {
  if (!isNativeOfflineStorageAvailable() || !files) return;
  await Promise.all(
    Object.values(files).map(async (asset) => {
      if (!asset?.path) return;
      await Filesystem.deleteFile({
        directory: Directory.Data,
        path: asset.path,
      }).catch(() => undefined);
    }),
  );
}
