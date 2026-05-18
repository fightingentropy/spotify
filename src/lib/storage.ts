import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/lib/env";

function resolveStorageRoots(): string[] {
  const roots: string[] = [];
  const home = process.env.HOME || "";

  for (const candidate of [
    resolve(process.cwd(), "music"),
    resolve(env.LOCAL_MUSIC_SOURCE_DIR),
    home ? resolve(home, "Music") : null,
  ]) {
    if (candidate && !roots.includes(candidate)) {
      roots.push(candidate);
    }
  }

  const mediaRoot = resolve(env.LOCAL_MEDIA_ROOT);
  if (!roots.includes(mediaRoot)) {
    roots.push(mediaRoot);
  }

  const projectRoot = resolve(process.cwd());
  if (!roots.includes(projectRoot)) {
    roots.push(projectRoot);
  }

  return roots;
}

const storageRoots = resolveStorageRoots();
const storageRoot = storageRoots[0];

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
  for (const root of storageRoots) {
    const absolutePath = resolve(root, normalizedKey);
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) {
      continue;
    }
    return absolutePath;
  }
  const absolutePath = resolve(storageRoot, normalizedKey);
  const rootPrefix = storageRoot.endsWith(sep) ? storageRoot : `${storageRoot}${sep}`;
  if (absolutePath !== storageRoot && !absolutePath.startsWith(rootPrefix)) {
    throw new Error("Invalid storage path");
  }
  return absolutePath;
}

export function absolutePathToStorageKey(absolutePath: string): string | null {
  const normalizedAbsolute = resolve(absolutePath);
  for (const root of storageRoots) {
    const rel = relative(root, normalizedAbsolute).split(sep).join("/");
    if (!rel || rel.startsWith("..")) {
      continue;
    }
    return rel;
  }
  return null;
}

export async function storageKeyExists(key: string): Promise<boolean> {
  try {
    await statObject(key);
    return true;
  } catch {
    return false;
  }
}

function apiUrlToStorageKey(url: string): string | null {
  if (!url.startsWith("/api/files/")) return null;
  return decodeURIComponent(url.slice("/api/files/".length));
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
  const normalizedKey = normalizeStorageKey(key);
  let lastError: unknown = null;
  for (const root of storageRoots) {
    const filePath = resolve(root, normalizedKey);
    try {
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
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Not found");
}

export async function getObjectStream(key: string) {
  const normalizedKey = normalizeStorageKey(key);
  for (const root of storageRoots) {
    const filePath = resolve(root, normalizedKey);
    try {
      await stat(filePath);
      return createReadStream(filePath);
    } catch {
      // Try the next storage root.
    }
  }
  return createReadStream(resolveStoragePath(normalizedKey));
}

export async function getPartialObjectStream(
  key: string,
  offset: number,
  length?: number,
) {
  const normalizedKey = normalizeStorageKey(key);
  const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const end =
    typeof length === "number" && Number.isFinite(length) && length > 0
      ? safeOffset + length - 1
      : undefined;

  for (const root of storageRoots) {
    const filePath = resolve(root, normalizedKey);
    try {
      await stat(filePath);
      return createReadStream(filePath, { start: safeOffset, end });
    } catch {
      // Try the next storage root.
    }
  }

  const filePath = resolveStoragePath(normalizedKey);
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
