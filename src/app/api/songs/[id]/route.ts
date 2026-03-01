import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateSongPayload = {
  title?: unknown;
  artist?: unknown;
};

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

  const existing = (await (db`
    SELECT "id", "userId"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  ` as any)) as Array<{ id: string; userId: string }>;
  if (!existing[0]) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }
  if (existing[0].userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = (await (db`
    UPDATE "Song"
    SET "title" = ${title}, "artist" = ${artist}
    WHERE "id" = ${songId}
    RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
  ` as any)) as Array<{
    id: string;
    title: string;
    artist: string;
    imageUrl: string;
    audioUrl: string;
    lyricsUrl: string | null;
    audioBitDepth: number | null;
    audioSampleRate: number | null;
    userId: string;
    createdAt: string;
  }>;

  return NextResponse.json(rows[0], { status: 200 });
}
