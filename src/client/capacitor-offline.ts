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

  const absoluteUrl = isAbsoluteHttpUrl(options.url) ? new URL(options.url, location.origin).toString() : null;

  // 1) Preferred: stream straight from the URL to disk so the whole file never
  //    lives in JS memory. Only base64 fallbacks below hold (chunked) data.
  if (absoluteUrl) {
    try {
      await Filesystem.downloadFile({ url: absoluteUrl, directory: Directory.Data, path, recursive: true });
      const resolved = await resolveNativeFileUri(path);
      return { ...baseAsset, uri: resolved.uri, size: resolved.size ?? options.blob.size };
    } catch {
      // Fall through to writing from the in-hand blob.
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
    return typeof stat.size === "number" ? stat.size > 0 : true;
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
