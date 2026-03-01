import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/lib/env";

const storageRoot = resolve(env.LOCAL_MEDIA_ROOT);

function normalizeStorageKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Invalid storage key");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid storage key");
  }
  return parts.join("/");
}

function resolveStoragePath(key: string): string {
  const normalizedKey = normalizeStorageKey(key);
  const absolutePath = resolve(storageRoot, normalizedKey);
  const rootPrefix = storageRoot.endsWith(sep) ? storageRoot : `${storageRoot}${sep}`;
  if (absolutePath !== storageRoot && !absolutePath.startsWith(rootPrefix)) {
    throw new Error("Invalid storage path");
  }
  return absolutePath;
}

async function ensureParentDir(targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
}

async function ensureStorageRoot(): Promise<void> {
  await mkdir(storageRoot, { recursive: true });
}

export function getObjectAbsolutePath(key: string): string {
  return resolveStoragePath(key);
}

export async function ensureBucketExists(): Promise<string> {
  await ensureStorageRoot();
  return storageRoot;
}

export async function putObjectFromBuffer(
  key: string,
  buffer: Buffer,
  _contentType?: string,
): Promise<void> {
  const filePath = resolveStoragePath(key);
  await ensureStorageRoot();
  await ensureParentDir(filePath);
  await writeFile(filePath, buffer);
}

export async function putObjectFromStream(
  key: string,
  stream: Readable,
  _contentType?: string,
): Promise<void> {
  const filePath = resolveStoragePath(key);
  await ensureStorageRoot();
  await ensureParentDir(filePath);
  await pipeline(stream, createWriteStream(filePath));
}

export async function statObject(key: string): Promise<{
  size: number;
  lastModified: Date;
  metaData: Record<string, string>;
}> {
  const filePath = resolveStoragePath(key);
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error("Not found");
  }
  return {
    size: Number(info.size),
    lastModified: info.mtime,
    metaData: {
      "content-type": inferContentTypeFromKey(key),
    },
  };
}

export async function getObjectStream(key: string) {
  const filePath = resolveStoragePath(key);
  await stat(filePath);
  return createReadStream(filePath);
}

export async function getPartialObjectStream(
  key: string,
  offset: number,
  length?: number,
) {
  const filePath = resolveStoragePath(key);
  const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const end =
    typeof length === "number" && Number.isFinite(length) && length > 0
      ? safeOffset + length - 1
      : undefined;
  return createReadStream(filePath, { start: safeOffset, end });
}

async function walkFiles(dirPath: string): Promise<Array<{ path: string; stats: Awaited<ReturnType<typeof stat>> }>> {
  const items: Array<{ path: string; stats: Awaited<ReturnType<typeof stat>> }> = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(abs);
      items.push(...nested);
      continue;
    }
    if (entry.isFile()) {
      const s = await stat(abs);
      items.push({ path: abs, stats: s });
    }
  }
  return items;
}

export async function listObjects(
  prefix: string,
): Promise<Array<{ name: string; size?: number; lastModified?: Date }>> {
  await ensureStorageRoot();
  const normalizedPrefix = prefix ? normalizeStorageKey(prefix) : "";
  const searchRoot = normalizedPrefix ? resolveStoragePath(normalizedPrefix) : storageRoot;
  let entries: Array<{ path: string; stats: Awaited<ReturnType<typeof stat>> }> = [];
  try {
    const rootStat = await stat(searchRoot);
    if (rootStat.isFile()) {
      entries = [{ path: searchRoot, stats: rootStat }];
    } else if (rootStat.isDirectory()) {
      entries = await walkFiles(searchRoot);
    }
  } catch {
    return [];
  }

  const result = entries
    .map(({ path, stats }) => {
      const rel = relative(storageRoot, path).split(sep).join("/");
      return {
        name: rel,
        size: Number(stats.size),
        lastModified: stats.mtime,
      };
    })
    .filter((item) => !normalizedPrefix || item.name.startsWith(normalizedPrefix))
    .sort((a, b) => a.name.localeCompare(b.name));

  return result;
}

export async function putObjectFromFilePath(
  key: string,
  filePath: string,
  _contentType?: string,
): Promise<void> {
  const destination = resolveStoragePath(key);
  await ensureStorageRoot();
  await ensureParentDir(destination);
  await copyFile(filePath, destination);
}

export function inferContentTypeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3") || lower.endsWith(".mpeg")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".lrc") || lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
