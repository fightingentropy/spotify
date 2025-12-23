type EnvShape = {
  DATABASE_URL: string;
  NEXTAUTH_SECRET: string;
  ADMIN_SECRET: string;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_USE_SSL: boolean;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_BUCKET: string;
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
  DATABASE_URL: requireEnv("DATABASE_URL"),
  NEXTAUTH_SECRET: requireEnv("NEXTAUTH_SECRET"),
  ADMIN_SECRET: requireEnv("ADMIN_SECRET"),
  MINIO_ENDPOINT: optionalEnv("MINIO_ENDPOINT", "127.0.0.1"),
  MINIO_PORT: numberEnv("MINIO_PORT", 9000),
  MINIO_USE_SSL: booleanEnv("MINIO_USE_SSL", false),
  MINIO_ACCESS_KEY: requireEnv("MINIO_ACCESS_KEY"),
  MINIO_SECRET_KEY: requireEnv("MINIO_SECRET_KEY"),
  MINIO_BUCKET: optionalEnv("MINIO_BUCKET", "uploads"),
  UPLOAD_MAX_IMAGE_BYTES: numberEnv("UPLOAD_MAX_IMAGE_BYTES", 5 * 1024 * 1024),
  UPLOAD_MAX_AUDIO_BYTES: numberEnv("UPLOAD_MAX_AUDIO_BYTES", 50 * 1024 * 1024),
  RATE_LIMIT_AUTH_MAX: numberEnv("RATE_LIMIT_AUTH_MAX", 20),
  RATE_LIMIT_AUTH_WINDOW_MS: numberEnv("RATE_LIMIT_AUTH_WINDOW_MS", 5 * 60 * 1000),
  RATE_LIMIT_REGISTER_MAX: numberEnv("RATE_LIMIT_REGISTER_MAX", 5),
  RATE_LIMIT_REGISTER_WINDOW_MS: numberEnv("RATE_LIMIT_REGISTER_WINDOW_MS", 10 * 60 * 1000),
  RATE_LIMIT_ADMIN_MAX: numberEnv("RATE_LIMIT_ADMIN_MAX", 30),
  RATE_LIMIT_ADMIN_WINDOW_MS: numberEnv("RATE_LIMIT_ADMIN_WINDOW_MS", 60 * 1000),
};
