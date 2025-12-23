import postgres from "postgres";
import { env } from "@/lib/env";

declare global {
  var __waveformDb: ReturnType<typeof postgres> | undefined;
}

const databaseUrl = env.DATABASE_URL;

const dbInstance =
  globalThis.__waveformDb ??
  postgres(databaseUrl, {
    max: 20, // Maximum connections in pool
    idle_timeout: 20, // Close idle connections after 20 seconds
    connect_timeout: 10, // Connection timeout in seconds
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__waveformDb = dbInstance;
}

export const db = dbInstance;

export type Db = typeof dbInstance;
