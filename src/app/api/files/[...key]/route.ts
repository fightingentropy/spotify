import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import {
  getObjectStream,
  getPartialObjectStream,
  statObject,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

function toResponseBody(
  stream: ReadableStream<Uint8Array> | Readable,
): BodyInit {
  if (stream instanceof Readable) {
    return Readable.toWeb(stream) as unknown as BodyInit;
  }
  return stream;
}

function parseRangeHeader(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=")) return null;
  const rangeValue = rangeHeader.slice("bytes=".length).trim();
  if (!rangeValue || rangeValue.includes(",")) return null;
  if (size <= 0) return null;

  const dashIndex = rangeValue.indexOf("-");
  if (dashIndex === -1) return null;

  const startStr = rangeValue.slice(0, dashIndex);
  const endStr = rangeValue.slice(dashIndex + 1);

  if (!startStr) {
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    const end = size - 1;
    const start = Math.max(0, size - suffixLength);
    if (start > end) return null;
    return { start, end };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return null;
  let end = endStr ? Number(endStr) : size - 1;
  if (!Number.isFinite(end) || end < 0) return null;
  if (start >= size) return null;
  if (end >= size) end = size - 1;
  if (end < start) return null;
  return { start, end };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  try {
    const { key } = await params;
    const objectKey = Array.isArray(key) ? key.join("/") : String(key);
    const stat = await statObject(objectKey).catch(() => null);
    if (!stat)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    const size = Number(stat.size || 0);
    const range = req.headers.get("range");
    const contentType =
      (stat.metaData?.["content-type"] as string) || "application/octet-stream";
    if (range) {
      const parsed = parseRangeHeader(range, size);
      if (!parsed) {
        const headers = new Headers();
        headers.set("Content-Range", `bytes */${size}`);
        headers.set("Accept-Ranges", "bytes");
        return new Response(null, { status: 416, headers });
      }
      const { start, end } = parsed;
      const length = Math.max(0, end - start + 1);
      const partial = await getPartialObjectStream(objectKey, start, length);
      const headers = new Headers();
      headers.set("Content-Type", contentType);
      headers.set("Content-Length", String(length));
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(toResponseBody(partial), { status: 206, headers });
    }
    const stream = await getObjectStream(objectKey);
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    if (size > 0) headers.set("Content-Length", String(size));
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(toResponseBody(stream), { headers });
  } catch (error) {
    console.error("Failed to stream object", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
