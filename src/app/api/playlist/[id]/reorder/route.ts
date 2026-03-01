import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

type ReorderPayload = {
  songIds?: unknown;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const playlistRows = (await (db`
    SELECT "id", "userId"
    FROM "Playlist"
    WHERE "id" = ${id}
    LIMIT 1
  ` as any)) as Array<{ id: string; userId: string }>;
  const playlist = playlistRows[0] ?? null;
  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }
  if (playlist.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: ReorderPayload = {};
  try {
    payload = (await req.json()) as ReorderPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(payload.songIds)) {
    return NextResponse.json({ error: "songIds must be an array" }, { status: 400 });
  }
  const requestedIds = payload.songIds
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const uniqueRequestedIds = [...new Set(requestedIds)];

  const existingRows = (await (db`
    SELECT "songId", "order"
    FROM "PlaylistSong"
    WHERE "playlistId" = ${id}
    ORDER BY "order" ASC
  ` as any)) as Array<{ songId: string; order: number }>;
  const existingIds = existingRows.map((row) => row.songId);
  const existingSet = new Set(existingIds);

  const orderedRequested = uniqueRequestedIds.filter((songId) => existingSet.has(songId));
  const remaining = existingIds.filter((songId) => !orderedRequested.includes(songId));
  const finalOrder = [...orderedRequested, ...remaining];

  for (let index = 0; index < finalOrder.length; index += 1) {
    const songId = finalOrder[index];
    await db`
      UPDATE "PlaylistSong"
      SET "order" = ${index}
      WHERE "playlistId" = ${id}
        AND "songId" = ${songId}
    `;
  }

  return NextResponse.json({ ok: true, songIds: finalOrder });
}
