import type { Readable } from "node:stream";
import type { CloudflareR2Bucket } from "@/lib/cloudflare";
import { inferContentTypeFromKey, normalizeStorageKey } from "@/lib/storage-keys";

function toWebStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> {
  if (!body) {
    throw new Error("Not found");
  }
  return body;
}

export async function r2StatObject(
  bucket: CloudflareR2Bucket,
  key: string,
): Promise<{
  size: number;
  lastModified: Date;
  metaData: Record<string, string>;
}> {
  const normalizedKey = normalizeStorageKey(key);
  const head = await bucket.head(normalizedKey);
  if (!head) {
    throw new Error("Not found");
  }
  return {
    size: head.size,
    lastModified: head.uploaded,
    metaData: {
      "content-type":
        head.httpMetadata?.contentType ?? inferContentTypeFromKey(normalizedKey),
    },
  };
}

export async function r2StorageKeyExists(
  bucket: CloudflareR2Bucket,
  key: string,
): Promise<boolean> {
  try {
    await r2StatObject(bucket, key);
    return true;
  } catch {
    return false;
  }
}

export async function r2GetObjectStream(
  bucket: CloudflareR2Bucket,
  key: string,
): Promise<ReadableStream<Uint8Array>> {
  const object = await bucket.get(normalizeStorageKey(key));
  return toWebStream(object?.body ?? null);
}

export async function r2GetPartialObjectStream(
  bucket: CloudflareR2Bucket,
  key: string,
  offset: number,
  length?: number,
): Promise<ReadableStream<Uint8Array>> {
  const safeOffset = Math.max(0, Number.isFinite(offset) ? offset : 0);
  const rangeLength =
    typeof length === "number" && Number.isFinite(length) && length > 0
      ? length
      : undefined;
  const object = await bucket.get(normalizeStorageKey(key), {
    range: rangeLength
      ? { offset: safeOffset, length: rangeLength }
      : { offset: safeOffset },
  });
  return toWebStream(object?.body ?? null);
}

export async function r2PutObjectFromBuffer(
  bucket: CloudflareR2Bucket,
  key: string,
  buffer: Buffer,
  contentType?: string,
): Promise<void> {
  await bucket.put(normalizeStorageKey(key), buffer, {
    httpMetadata: {
      contentType: contentType ?? inferContentTypeFromKey(key),
    },
  });
}

export async function r2PutObjectFromStream(
  bucket: CloudflareR2Bucket,
  key: string,
  stream: Readable,
  contentType?: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await r2PutObjectFromBuffer(
    bucket,
    key,
    Buffer.concat(chunks),
    contentType,
  );
}

export async function r2ListObjects(
  bucket: CloudflareR2Bucket,
  prefix: string,
): Promise<Array<{ name: string; size?: number; lastModified?: Date }>> {
  const normalizedPrefix = prefix ? normalizeStorageKey(prefix) : "";
  const listed = await bucket.list({ prefix: normalizedPrefix || undefined });
  return listed.objects
    .map((object) => ({
      name: object.key,
      size: object.size,
      lastModified: object.uploaded,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
