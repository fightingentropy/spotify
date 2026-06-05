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
  const data = await blobToBase64(options.blob);
  const result = await Filesystem.writeFile({
    directory: Directory.Data,
    path,
    data,
    recursive: true,
  });
  return {
    kind: options.kind,
    originalUrl: options.url,
    path,
    uri: result.uri,
    size: options.blob.size,
    contentType: options.blob.type || undefined,
  };
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
