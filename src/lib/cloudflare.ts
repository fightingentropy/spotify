type D1PreparedStatement = {
  bind: (...values: unknown[]) => {
    all: <T>() => Promise<{ results?: T[] }>;
    run: () => Promise<unknown>;
  };
};

export type CloudflareD1Database = {
  prepare: (sql: string) => D1PreparedStatement;
};

export type CloudflareR2Bucket = {
  head: (key: string) => Promise<{
    size: number;
    uploaded: Date;
    httpMetadata?: { contentType?: string };
  } | null>;
  get: (
    key: string,
    options?: {
      range?: { offset?: number; length?: number };
    },
  ) => Promise<{ body: ReadableStream<Uint8Array> | null } | null>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
    options?: { httpMetadata?: { contentType?: string } },
  ) => Promise<unknown>;
  list: (options?: {
    prefix?: string;
  }) => Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
  }>;
};

export type CloudflareBindings = {
  DB: CloudflareD1Database;
  MEDIA: CloudflareR2Bucket;
};

export async function getCloudflareBindings(): Promise<CloudflareBindings | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const bindings = env as Partial<CloudflareBindings>;
    if (!bindings.DB || !bindings.MEDIA) {
      return null;
    }
    return { DB: bindings.DB, MEDIA: bindings.MEDIA };
  } catch {
    return null;
  }
}
