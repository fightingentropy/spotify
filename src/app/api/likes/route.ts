import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json(
      { likes: [] },
      {
        status: 200,
        headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
      },
    );
  }

  const likes = await db<{ songId: string }>`
    SELECT "songId"
    FROM "Like"
    WHERE "userId" = ${userId}
  `;

  // Short private cache lets back/forward nav reuse the response without
  // hitting the DB. The likes store already mutates optimistically, so a
  // 30s staleness window is imperceptible to users.
  return NextResponse.json(
    { likes: likes.map((like) => like.songId) },
    {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
      },
    },
  );
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await parseJsonBody<{ songId?: unknown }>(req);
  const songId = typeof payload.songId === "string" ? payload.songId : null;
  if (!songId) {
    return NextResponse.json({ error: "Missing songId" }, { status: 400 });
  }

  const song = await db<{ id: string }>`
    SELECT "id"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  `;
  if (song.length === 0) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }

  await db`
    INSERT INTO "Like" ("id", "userId", "songId", "createdAt")
    VALUES (${randomUUID()}, ${userId}, ${songId}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "songId")
    DO NOTHING
  `;

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await parseJsonBody<{ songId?: unknown }>(req);
  const songId = typeof payload.songId === "string" ? payload.songId : null;
  if (!songId) {
    return NextResponse.json({ error: "Missing songId" }, { status: 400 });
  }

  await db`
    DELETE FROM "Like"
    WHERE "userId" = ${userId} AND "songId" = ${songId}
  `;

  return NextResponse.json({ ok: true });
}

async function parseJsonBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
