import { NextResponse } from "next/server";
import { parseStream } from "music-metadata";
import { Readable } from "node:stream";
import { getObjectStream, statObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ file: string[] }> }) {
  const { file } = await params;
  const segments = Array.isArray(file) ? file : [file];
  const objectKey = ["audio", ...segments].join("/");

  try {
    const st = await statObject(objectKey).catch(() => null);
    if (!st) throw new Error("not found");
    const stream = await getObjectStream(objectKey);
    try {
      const meta = await parseStream(stream as unknown as Readable, "audio/mpeg", {
        duration: false,
        skipCovers: false,
        fileSize: Number(st.size || 0),
      } as unknown as { duration?: boolean; skipCovers?: boolean; fileSize?: number });
      const picture = meta.common.picture?.[0];
      if (picture?.data?.length) {
        const headers = new Headers();
        headers.set("Content-Type", picture.format || "image/jpeg");
        headers.set("Cache-Control", "public, max-age=604800, immutable");
        const arrayBuffer = new ArrayBuffer(picture.data.byteLength);
        new Uint8Array(arrayBuffer).set(picture.data);
        return new Response(arrayBuffer, { headers });
      }
    } finally {
      // Ensure the audio stream is closed, we only needed the metadata
      try {
        (stream as unknown as Readable)?.destroy?.();
      } catch {}
    }
  } catch {}

  // Fallback to a MinIO-hosted image for consistent UX
  try {
    const fallbackKey = "images/helix-1.jpg";
    const fallbackStat = await statObject(fallbackKey).catch(() => null);
    if (!fallbackStat) throw new Error("no fallback");
    const imgStream = await getObjectStream(fallbackKey);
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=604800, immutable");
    // @ts-expect-error Node stream in web Response
    return new Response(imgStream, { headers });
  } catch {
    return NextResponse.json({ error: "Artwork not found" }, { status: 404 });
  }
}


