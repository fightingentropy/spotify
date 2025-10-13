import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/auth";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { putObjectFromBuffer } from "@/lib/storage";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const songs = await (db`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "userId", "createdAt"
    FROM "Song"
    ORDER BY "title" ASC
  ` as any) as SongRow[];
  return NextResponse.json(songs);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  type AppSession = Session & { user: NonNullable<Session["user"]> & { id: string } };
  const s = session as AppSession | null;
  if (!s?.user?.email || !s.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const title = String(form.get("title") ?? "").trim();
  const artist = String(form.get("artist") ?? "").trim();
  const image = form.get("image") as File | null;
  const audio = form.get("audio") as File | null;

  if (!title || !artist || !image || !audio) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const imgId = uuidv4();
  const audId = uuidv4();
  const imageFileName = `${imgId}-${image.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const audioFileName = `${audId}-${audio.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;

  const [imageArrayBuffer, audioArrayBuffer] = await Promise.all([
    image.arrayBuffer(),
    audio.arrayBuffer(),
  ]);

  const [imageBuffer, audioBuffer] = [Buffer.from(imageArrayBuffer), Buffer.from(audioArrayBuffer)];
  const imageKey = join("images", imageFileName).replaceAll("\\", "/");
  const audioKey = join("audio", audioFileName).replaceAll("\\", "/");
  await Promise.all([
    putObjectFromBuffer(imageKey, imageBuffer, image.type || undefined),
    putObjectFromBuffer(audioKey, audioBuffer, audio.type || undefined),
  ]);

  const imageUrl = `/api/files/images/${encodeURIComponent(imageFileName)}`;
  const audioUrl = `/api/files/audio/${encodeURIComponent(audioFileName)}`;

  const userId = s.user.id;
  const songId = randomUUID();
  const [song] = await (db`
    INSERT INTO "Song" ("id", "title", "artist", "imageUrl", "audioUrl", "userId")
    VALUES (${songId}, ${title}, ${artist}, ${imageUrl}, ${audioUrl}, ${userId})
    RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "userId", "createdAt"
  ` as any) as SongRow[];

  return NextResponse.json(song, { status: 201 });
}
