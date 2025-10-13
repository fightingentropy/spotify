import { NextResponse } from "next/server";
import { getObjectStream, getPartialObjectStream, statObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const { key } = await params;
    const objectKey = Array.isArray(key) ? key.join("/") : String(key);
    const stat = await statObject(objectKey).catch(() => null);
    if (!stat) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const size = Number(stat.size || 0);
    const range = req.headers.get("range");
    const contentType = (stat.metaData?.["content-type"] as string) || "application/octet-stream";
    if (range && /^bytes=\d+-\d*$/.test(range)) {
      const [startStr, endStr] = range.replace("bytes=", "").split("-");
      const start = Number(startStr);
      const end = endStr ? Number(endStr) : Math.max(0, size - 1);
      if (Number.isFinite(start) && start < size) {
        const length = Math.max(0, end - start + 1);
        const partial = await getPartialObjectStream(objectKey, start, length);
        const headers = new Headers();
        headers.set("Content-Type", contentType);
        headers.set("Content-Length", String(length));
        headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        // @ts-expect-error Node stream in web Response
        return new Response(partial, { status: 206, headers });
      }
    }
    const stream = await getObjectStream(objectKey);
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    if (size > 0) headers.set("Content-Length", String(size));
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    // @ts-expect-error Node stream in web Response
    return new Response(stream, { headers });
  } catch (error) {
    console.error("Failed to stream object", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

