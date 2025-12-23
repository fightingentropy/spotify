import { NextResponse } from "next/server";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { putObjectFromFilePath, statObject } from "@/lib/storage";
import { env } from "@/lib/env";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function walkFiles(baseDir: string, relDir = ""): Promise<string[]> {
  const dirPath = join(baseDir, relDir);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await walkFiles(baseDir, relPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function inferContentType(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3") || lower.endsWith(".mpeg")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return undefined;
}

export async function POST(req: Request) {
  const rate = rateLimit(req, {
    keyPrefix: "admin-batch-upload",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  });
  if (!rate.allowed) {
    console.warn("[security] admin batch upload rate limit exceeded", {
      ip: rate.ip,
    });
    const headers = rateLimitHeaders(rate);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers },
    );
  }

  const adminSecret = env.ADMIN_SECRET;
  const provided = req.headers.get("x-admin-secret") || "";
  if (!provided || provided !== adminSecret) {
    console.warn("[security] admin batch upload forbidden", {
      ip: rate.ip,
      hasSecret: Boolean(provided),
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  console.info("[security] admin batch upload accepted", { ip: rate.ip });

  const root = join(process.cwd(), "public", "uploads");
  // Confirm root exists
  try {
    const s = await stat(root);
    if (!s.isDirectory()) throw new Error("uploads not a dir");
  } catch {
    return NextResponse.json(
      { error: "Local uploads directory not found" },
      { status: 400 },
    );
  }

  // Collect images
  const imagesDir = join(root, "images");
  const audioDir = join(root, "audio");

  let imageFiles: string[] = [];
  let audioFiles: string[] = [];
  try {
    imageFiles = await walkFiles(imagesDir);
  } catch {
    imageFiles = [];
  }
  try {
    audioFiles = await walkFiles(audioDir);
  } catch {
    audioFiles = [];
  }

  let uploaded = 0;
  let skipped = 0;
  const errors: Array<{ key: string; message: string }> = [];

  // Upload images -> images/<name>
  for (const rel of imageFiles) {
    const key = `images/${rel.replace(/\\/g, "/")}`;
    const filePath = join(imagesDir, rel);
    const exists = await statObject(key).catch(() => null);
    if (exists) {
      skipped++;
      continue;
    }
    try {
      await putObjectFromFilePath(key, filePath, inferContentType(rel));
      uploaded++;
    } catch (e) {
      errors.push({
        key,
        message: e instanceof Error ? e.message : "upload failed",
      });
    }
  }

  // Upload audio -> audio/<relative path>
  for (const rel of audioFiles) {
    const key = `audio/${rel.replace(/\\/g, "/")}`;
    const filePath = join(audioDir, rel);
    const exists = await statObject(key).catch(() => null);
    if (exists) {
      skipped++;
      continue;
    }
    try {
      await putObjectFromFilePath(key, filePath, inferContentType(rel));
      uploaded++;
    } catch (e) {
      errors.push({
        key,
        message: e instanceof Error ? e.message : "upload failed",
      });
    }
  }

  return NextResponse.json({
    uploaded,
    skipped,
    total: imageFiles.length + audioFiles.length,
    errors,
  });
}
