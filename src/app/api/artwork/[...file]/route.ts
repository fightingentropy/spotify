import { NextResponse } from "next/server";
import { parseFile } from "music-metadata";
import { getObjectAbsolutePath, statObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string[] }> },
) {
  const { file } = await params;
  const segments = Array.isArray(file) ? file : [file];
  const objectKey = ["audio", ...segments].join("/");

  try {
    const info = await statObject(objectKey).catch(() => null);
    if (!info) {
      throw new Error("not found");
    }
    const audioPath = getObjectAbsolutePath(objectKey);
    const meta = await parseFile(audioPath, {
      duration: false,
      skipCovers: false,
      fileSize: Number(info.size || 0),
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
  } catch {}

  return NextResponse.redirect(new URL("/waveform.svg", req.url), 302);
}

