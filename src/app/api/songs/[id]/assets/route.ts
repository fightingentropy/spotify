import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { ensureSongLyricsColumn } from "@/lib/db-migrations";
import { env } from "@/lib/env";
import { putObjectFromBuffer } from "@/lib/storage";

export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const LYRICS_EXTENSIONS = new Set([".txt", ".lrc"]);
const LYRICS_MIME_TYPES = new Set([
  "text/plain",
  "application/octet-stream",
  "application/x-subrip",
]);

const MAX_LYRICS_BYTES = 2 * 1024 * 1024;

function toApiFileUrl(key: string): string {
  return `/api/files/${key.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9.\-_ ]/g, "_").replace(/\s+/g, " ");
  return safe || "unknown";
}

function buildOrganizedMusicBasePath(title: string, artist: string): string {
  return join("music", sanitizePathSegment(artist), sanitizePathSegment(title)).replaceAll("\\", "/");
}

function sanitizeName(fileName: string): string {
  const clean = basename(fileName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  return clean.length > 0 ? clean : "upload";
}

function resolveImageExt(file: File): string | null {
  const ext = extname(sanitizeName(file.name)).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return ext === ".jpeg" ? ".jpg" : ext;
  }
  const mime = file.type.toLowerCase();
  if (!IMAGE_MIME_TYPES.has(mime)) {
    return null;
  }
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

function resolveLyricsExt(file: File): string | null {
  const ext = extname(sanitizeName(file.name)).toLowerCase();
  if (LYRICS_EXTENSIONS.has(ext)) {
    return ext;
  }
  const mime = file.type.toLowerCase();
  if (!LYRICS_MIME_TYPES.has(mime)) {
    return null;
  }
  return ".txt";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSongLyricsColumn();

  const { id } = await params;
  const songId = typeof id === "string" ? id : "";
  if (!songId) {
    return NextResponse.json({ error: "Missing song id" }, { status: 400 });
  }

  const songs = await db<{
    id: string;
    title: string;
    artist: string;
    imageUrl: string;
    lyricsUrl: string | null;
    userId: string;
  }>`
    SELECT "id", "title", "artist", "imageUrl", "lyricsUrl", "userId"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  `;
  const song = songs[0] ?? null;
  if (!song) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }
  if (song.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData();
  const image = form.get("image");
  const lyricsFile = form.get("lyricsFile");
  const lyricsTextRaw = form.get("lyricsText");
  const lyricsText = typeof lyricsTextRaw === "string" ? lyricsTextRaw.trim() : "";

  const hasImage = image instanceof File && image.size > 0;
  const hasLyricsFile = lyricsFile instanceof File && lyricsFile.size > 0;
  const hasLyricsText = lyricsText.length > 0;

  if (!hasImage && !hasLyricsFile && !hasLyricsText) {
    return NextResponse.json(
      { error: "Provide an image, lyrics file, or lyrics text" },
      { status: 400 },
    );
  }

  let imageUrl = song.imageUrl;
  let lyricsUrl = song.lyricsUrl;
  const basePath = buildOrganizedMusicBasePath(song.title, song.artist);

  if (hasImage && image instanceof File) {
    if (image.size > env.UPLOAD_MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Image exceeds max upload size" }, { status: 413 });
    }

    const imageExt = resolveImageExt(image);
    if (!imageExt) {
      return NextResponse.json({ error: "Unsupported image format" }, { status: 415 });
    }

    const imageBuffer = Buffer.from(await image.arrayBuffer());
    const imageKey = `${basePath}/cover/${song.id}-${randomUUID()}${imageExt}`;
    await putObjectFromBuffer(imageKey, imageBuffer, image.type || undefined);
    imageUrl = toApiFileUrl(imageKey);
  }

  if (hasLyricsFile && lyricsFile instanceof File) {
    if (lyricsFile.size > MAX_LYRICS_BYTES) {
      return NextResponse.json({ error: "Lyrics file is too large" }, { status: 413 });
    }

    const lyricsExt = resolveLyricsExt(lyricsFile);
    if (!lyricsExt) {
      return NextResponse.json({ error: "Unsupported lyrics format" }, { status: 415 });
    }

    const lyricsBuffer = Buffer.from(await lyricsFile.arrayBuffer());
    const lyricsKey = `${basePath}/lyrics/${song.id}-${randomUUID()}${lyricsExt}`;
    await putObjectFromBuffer(lyricsKey, lyricsBuffer, "text/plain; charset=utf-8");
    lyricsUrl = toApiFileUrl(lyricsKey);
  } else if (hasLyricsText) {
    const textBuffer = Buffer.from(lyricsText, "utf8");
    if (textBuffer.byteLength > MAX_LYRICS_BYTES) {
      return NextResponse.json({ error: "Lyrics text is too large" }, { status: 413 });
    }
    const lyricsKey = `${basePath}/lyrics/${song.id}-${randomUUID()}.txt`;
    await putObjectFromBuffer(lyricsKey, textBuffer, "text/plain; charset=utf-8");
    lyricsUrl = toApiFileUrl(lyricsKey);
  }

  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "imageUrl" = ${imageUrl}, "lyricsUrl" = ${lyricsUrl}
    WHERE "id" = ${song.id}
    RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;

  return NextResponse.json(rows[0], { status: 200 });
}
