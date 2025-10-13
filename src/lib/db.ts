import postgres from "postgres";

declare global {
  var __waveformDb: ReturnType<typeof postgres> | undefined;
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const dbInstance = globalThis.__waveformDb ?? postgres(databaseUrl, {
  max: 20, // Maximum connections in pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout in seconds
});

if (process.env.NODE_ENV !== "production") {
  globalThis.__waveformDb = dbInstance;
}

export const db = dbInstance;

export type Db = typeof dbInstance;
