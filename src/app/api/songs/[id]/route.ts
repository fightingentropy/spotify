import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";
import { songToPlayerSong } from "@/lib/song-utils";

export const dynamic = "force-dynamic";

type UpdateSongPayload = {
  title?: unknown;
  artist?: unknown;
};

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();

  const { id } = await params;
  const songId = typeof id === "string" ? id : "";
  if (!songId) {
    return NextResponse.json({ error: "Missing song id" }, { status: 400 });
  }

  const rows = await db<SongRow>`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  `;

  if (!rows[0]) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }

  return NextResponse.json(songToPlayerSong(rows[0]), { status: 200 });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();

  const { id } = await params;
  const songId = typeof id === "string" ? id : "";
  if (!songId) {
    return NextResponse.json({ error: "Missing song id" }, { status: 400 });
  }

  let payload: UpdateSongPayload;
  try {
    payload = (await req.json()) as UpdateSongPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = toStringValue(payload.title);
  const artist = toStringValue(payload.artist);
  if (!title || !artist) {
    return NextResponse.json(
      { error: "Title and artist are required" },
      { status: 400 },
    );
  }

  const existing = await db<{ id: string; userId: string }>`
    SELECT "id", "userId"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  `;
  if (!existing[0]) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }
  if (existing[0].userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await db<SongRow>`
    UPDATE "Song"
    SET "title" = ${title}, "artist" = ${artist}
    WHERE "id" = ${songId}
    RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  `;

  return NextResponse.json(rows[0], { status: 200 });
}
