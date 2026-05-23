import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { getCloudflareBindings } from "@/lib/cloudflare";
import { env } from "@/lib/env";
import {
  inferContentTypeFromKey,
  normalizeStorageKey,
} from "@/lib/storage-keys";
import {
  r2GetObjectStream,
  r2GetPartialObjectStream,
  r2ListObjects,
  r2PutObjectFromBuffer,
  r2PutObjectFromStream,
  r2StatObject,
  r2StorageKeyExists,
} from "@/lib/storage-r2";

type LocalStorageModule = typeof import("@/lib/storage-local");

let localStoragePromise: Promise<LocalStorageModule> | null = null;

async function getLocalStorage(): Promise<LocalStorageModule> {
  if (!localStoragePromise) {
    localStoragePromise = (Function(
      'return import("@/lib/storage-local")',
    ) as () => Promise<LocalStorageModule>)();
  }
  return localStoragePromise;
}

export function getMusicSourceDirectoryCandidates(): string[] {
  const home = process.env.HOME || "";
  const candidates = [
    resolve(process.cwd(), "music"),
    resolve(env.LOCAL_MUSIC_SOURCE_DIR),
  ];
  if (home) {
    candidates.push(resolve(home, "Music"));
  }
  const unique: string[] = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique;
}

export function getMusicDirectoryCandidates(): string[] {
  const candidates = getMusicSourceDirectoryCandidates();
  if (env.LOCAL_MUSIC_COPY_FILES) {
    const archive = resolve(env.LOCAL_MEDIA_ROOT, "music");
    if (!candidates.includes(archive)) {
      candidates.push(archive);
    }
  }
  return candidates;
}

export async function absolutePathToStorageKey(
  absolutePath: string,
): Promise<string | null> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return null;
  }
  const local = await getLocalStorage();
  return local.absolutePathToStorageKey(absolutePath);
}

export async function storageKeyExists(key: string): Promise<boolean> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return r2StorageKeyExists(bindings.MEDIA, key);
  }
  try {
    await statObject(key);
    return true;
  } catch {
    return false;
  }
}

export async function getObjectAbsolutePath(key: string): Promise<string> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return normalizeStorageKey(key);
  }
  const local = await getLocalStorage();
  return local.getObjectAbsolutePath(key);
}

export async function ensureBucketExists(): Promise<string> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return "r2://waveform-media";
  }
  const local = await getLocalStorage();
  return local.ensureBucketExists();
}

export async function putObjectFromBuffer(
  key: string,
  buffer: Buffer,
  contentType?: string,
): Promise<void> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    await r2PutObjectFromBuffer(bindings.MEDIA, key, buffer, contentType);
    return;
  }
  const local = await getLocalStorage();
  await local.putObjectFromBuffer(key, buffer, contentType);
}

export async function putObjectFromStream(
  key: string,
  stream: Readable,
  contentType?: string,
): Promise<void> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    await r2PutObjectFromStream(bindings.MEDIA, key, stream, contentType);
    return;
  }
  const local = await getLocalStorage();
  await local.putObjectFromStream(key, stream, contentType);
}

export async function statObject(key: string): Promise<{
  size: number;
  lastModified: Date;
  metaData: Record<string, string>;
}> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return r2StatObject(bindings.MEDIA, key);
  }
  const local = await getLocalStorage();
  return local.statObject(key);
}

export async function getObjectStream(
  key: string,
): Promise<ReadableStream<Uint8Array> | Readable> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return r2GetObjectStream(bindings.MEDIA, key);
  }
  const local = await getLocalStorage();
  return local.getObjectStream(key);
}

export async function getPartialObjectStream(
  key: string,
  offset: number,
  length?: number,
): Promise<ReadableStream<Uint8Array> | Readable> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return r2GetPartialObjectStream(bindings.MEDIA, key, offset, length);
  }
  const local = await getLocalStorage();
  return local.getPartialObjectStream(key, offset, length);
}

export async function listObjects(
  prefix: string,
): Promise<Array<{ name: string; size?: number; lastModified?: Date }>> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    return r2ListObjects(bindings.MEDIA, prefix);
  }
  const local = await getLocalStorage();
  return local.listObjects(prefix);
}

export async function putObjectFromFilePath(
  key: string,
  filePath: string,
  contentType?: string,
): Promise<void> {
  const bindings = await getCloudflareBindings();
  if (bindings) {
    throw new Error("Direct file-path uploads are not supported on Cloudflare");
  }
  const local = await getLocalStorage();
  await local.putObjectFromFilePath(key, filePath, contentType);
}

export { inferContentTypeFromKey, normalizeStorageKey };
