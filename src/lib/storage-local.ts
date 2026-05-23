import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "@/lib/env";
import {
  inferContentTypeFromKey,
  normalizeStorageKey,
} from "@/lib/storage-keys";

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

export async function getObjectStream(key: string): Promise<Readable> {
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
): Promise<Readable> {
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

async function walkFiles(
  dirPath: string,
): Promise<Array<{ path: string; stats: Awaited<ReturnType<typeof stat>> }>> {
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
      const fileStats = await stat(abs);
      items.push({ path: abs, stats: fileStats });
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

  return entries
    .map(({ path, stats: fileStats }) => {
      const rel = relative(storageRoot, path).split(sep).join("/");
      return {
        name: rel,
        size: Number(fileStats.size),
        lastModified: fileStats.mtime,
      };
    })
    .filter((item) => !normalizedPrefix || item.name.startsWith(normalizedPrefix))
    .sort((left, right) => left.name.localeCompare(right.name));
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
