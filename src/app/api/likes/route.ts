import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ likes: [] }, { status: 200 });
  }

  const likes = await (db`
    SELECT "songId"
    FROM "Like"
    WHERE "userId" = ${userId}
  ` as any) as { songId: string }[];

  return NextResponse.json({ likes: likes.map((like) => like.songId) });
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

  const song = await (db`
    SELECT "id"
    FROM "Song"
    WHERE "id" = ${songId}
    LIMIT 1
  ` as any) as { id: string }[];
  if (song.length === 0) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }

  await db`
    INSERT INTO "Like" ("id", "userId", "songId", "createdAt")
    VALUES (${randomUUID()}, ${userId}, ${songId}, NOW())
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
