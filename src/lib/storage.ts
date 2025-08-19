import { Client as MinioClient } from "minio";

type StorageConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

let storageClient: MinioClient | null = null;
let storageConfig: StorageConfig | null = null;

function getConfig(): StorageConfig {
  if (storageConfig) return storageConfig;
  const endPoint = process.env.MINIO_ENDPOINT || "127.0.0.1";
  const port = Number(process.env.MINIO_PORT || 9000);
  const useSSL = String(process.env.MINIO_USE_SSL || "false").toLowerCase() === "true";
  const accessKey = process.env.MINIO_ACCESS_KEY || "waveform";
  const secretKey = process.env.MINIO_SECRET_KEY || "waveformsecret";
  const bucket = process.env.MINIO_BUCKET || "uploads";
  storageConfig = { endPoint, port, useSSL, accessKey, secretKey, bucket };
  return storageConfig;
}

export function getMinioClient(): MinioClient {
  if (storageClient) return storageClient;
  const cfg = getConfig();
  storageClient = new MinioClient({
    endPoint: cfg.endPoint,
    port: cfg.port,
    useSSL: cfg.useSSL,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });
  return storageClient;
}

export async function ensureBucketExists(): Promise<string> {
  const cfg = getConfig();
  const client = getMinioClient();
  const bucket = cfg.bucket;
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket, "us-east-1");
  }
  return bucket;
}

export async function putObjectFromBuffer(key: string, buffer: Buffer, contentType?: string): Promise<void> {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  await client.putObject(bucket, key, buffer, buffer.length, {
    "Content-Type": contentType || inferContentTypeFromKey(key),
  });
}

export async function statObject(key: string) {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  return client.statObject(bucket, key);
}

export async function getObjectStream(key: string) {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  return client.getObject(bucket, key);
}

export async function getPartialObjectStream(key: string, offset: number, length?: number) {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  return client.getPartialObject(bucket, key, offset, length ?? 0);
}

export async function listObjects(prefix: string): Promise<Array<{ name: string; size?: number; lastModified?: Date }>> {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  const stream = client.listObjectsV2(bucket, prefix, true);
  const items: Array<{ name: string; size?: number; lastModified?: Date }> = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (obj: unknown) => {
      const o = obj as { name?: unknown; size?: number; lastModified?: Date };
      if (o && typeof o.name === "string") items.push({ name: o.name, size: o.size, lastModified: o.lastModified });
    });
    stream.on("end", () => resolve(items));
    stream.on("error", (err: unknown) => reject(err));
  });
}

export async function putObjectFromFilePath(key: string, filePath: string, contentType?: string): Promise<void> {
  const bucket = await ensureBucketExists();
  const client = getMinioClient();
  const meta: Record<string, string> | undefined = contentType ? { "Content-Type": contentType } : undefined;
  // fPutObject handles file reading and content-length
  await client.fPutObject(bucket, key, filePath, meta);
}

function inferContentTypeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3") || lower.endsWith(".mpeg")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}


