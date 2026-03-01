import { join } from "node:path";

type EnvShape = {
  SQLITE_DB_PATH: string;
  NEXTAUTH_SECRET: string;
  ADMIN_SECRET: string;
  LOCAL_MEDIA_ROOT: string;
  LOCAL_MUSIC_SOURCE_DIR: string;
  LOCAL_IMPORT_USE_COVER_FILES: boolean;
  LOCAL_IMPORT_USE_LYRICS_FILES: boolean;
  UPLOAD_MAX_IMAGE_BYTES: number;
  UPLOAD_MAX_AUDIO_BYTES: number;
  RATE_LIMIT_AUTH_MAX: number;
  RATE_LIMIT_AUTH_WINDOW_MS: number;
  RATE_LIMIT_REGISTER_MAX: number;
  RATE_LIMIT_REGISTER_WINDOW_MS: number;
  RATE_LIMIT_ADMIN_MAX: number;
  RATE_LIMIT_ADMIN_WINDOW_MS: number;
};

function requireEnv(name: keyof EnvShape): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberEnv(name: keyof EnvShape, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (value <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
  return value;
}

function booleanEnv(name: keyof EnvShape, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function optionalEnv(name: keyof EnvShape, fallback: string): string {
  return process.env[name] || fallback;
}

export const env: EnvShape = {
  SQLITE_DB_PATH: optionalEnv(
    "SQLITE_DB_PATH",
    join(process.cwd(), "waveform.sqlite"),
  ),
  NEXTAUTH_SECRET: requireEnv("NEXTAUTH_SECRET"),
  ADMIN_SECRET: requireEnv("ADMIN_SECRET"),
  LOCAL_MEDIA_ROOT: optionalEnv(
    "LOCAL_MEDIA_ROOT",
    join(process.cwd(), "local-media"),
  ),
  LOCAL_MUSIC_SOURCE_DIR: optionalEnv(
    "LOCAL_MUSIC_SOURCE_DIR",
    "/Users/erlinhoxha/Music",
  ),
  LOCAL_IMPORT_USE_COVER_FILES: booleanEnv(
    "LOCAL_IMPORT_USE_COVER_FILES",
    true,
  ),
  LOCAL_IMPORT_USE_LYRICS_FILES: booleanEnv(
    "LOCAL_IMPORT_USE_LYRICS_FILES",
    true,
  ),
  UPLOAD_MAX_IMAGE_BYTES: numberEnv("UPLOAD_MAX_IMAGE_BYTES", 5 * 1024 * 1024),
  UPLOAD_MAX_AUDIO_BYTES: numberEnv("UPLOAD_MAX_AUDIO_BYTES", 50 * 1024 * 1024),
  RATE_LIMIT_AUTH_MAX: numberEnv("RATE_LIMIT_AUTH_MAX", 20),
  RATE_LIMIT_AUTH_WINDOW_MS: numberEnv("RATE_LIMIT_AUTH_WINDOW_MS", 5 * 60 * 1000),
  RATE_LIMIT_REGISTER_MAX: numberEnv("RATE_LIMIT_REGISTER_MAX", 5),
  RATE_LIMIT_REGISTER_WINDOW_MS: numberEnv("RATE_LIMIT_REGISTER_WINDOW_MS", 10 * 60 * 1000),
  RATE_LIMIT_ADMIN_MAX: numberEnv("RATE_LIMIT_ADMIN_MAX", 30),
  RATE_LIMIT_ADMIN_WINDOW_MS: numberEnv("RATE_LIMIT_ADMIN_WINDOW_MS", 60 * 1000),
};
