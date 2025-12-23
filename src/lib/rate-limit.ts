type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  ip: string;
};

declare global {
  var __waveformRateLimit: Map<string, RateLimitEntry> | undefined;
}

const store = globalThis.__waveformRateLimit ?? new Map<string, RateLimitEntry>();
if (!globalThis.__waveformRateLimit) {
  globalThis.__waveformRateLimit = store;
}

export function getRequestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

export function rateLimit(
  req: Request,
  options: { keyPrefix: string; max: number; windowMs: number },
): RateLimitResult {
  const ip = getRequestIp(req);
  const key = `${options.keyPrefix}:${ip}`;
  const now = Date.now();
  let entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + options.windowMs };
  }
  entry.count += 1;
  store.set(key, entry);
  const remaining = Math.max(0, options.max - entry.count);
  return {
    allowed: entry.count <= options.max,
    remaining,
    resetAt: entry.resetAt,
    limit: options.max,
    ip,
  };
}

export function rateLimitHeaders(result: RateLimitResult): Headers {
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(result.limit));
  headers.set("X-RateLimit-Remaining", String(result.remaining));
  headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  if (!result.allowed) {
    const retryAfter = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
    headers.set("Retry-After", String(retryAfter));
  }
  return headers;
}
