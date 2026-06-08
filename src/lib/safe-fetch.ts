import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REMOTE_REDIRECTS = 5;

export class RemoteUrlError extends Error {}

export function isPrivateOrReservedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map((part) => Number(part));
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedIpAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

export function isBlockedRemoteHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    !normalized.includes(".") ||
    (isIP(normalized) !== 0 && isPrivateOrReservedIpAddress(normalized))
  );
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteUrlError("Only valid http(s) URLs are supported");
  }
  if (url.username || url.password) {
    throw new RemoteUrlError("Remote URLs with credentials are not supported");
  }
  if (isBlockedRemoteHostname(url.hostname)) {
    throw new RemoteUrlError("Remote URL host is not allowed");
  }

  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw new RemoteUrlError("Remote URL host could not be resolved");
  if (addresses.some(({ address }) => isPrivateOrReservedIpAddress(address))) {
    throw new RemoteUrlError("Remote URL host resolves to a private network address");
  }
}

export async function fetchPublicHttpUrl(url: URL, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  let nextUrl = url;
  let nextInit = { ...init };

  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_REDIRECTS; redirectCount += 1) {
    await assertPublicHttpUrl(nextUrl);
    const response = await fetchWithTimeout(
      nextUrl.toString(),
      { ...nextInit, redirect: "manual" },
      timeoutMs,
    );

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) return response;

    nextUrl = new URL(location, nextUrl);
    if (response.status === 303) {
      nextInit = { ...nextInit, method: "GET", body: undefined };
    }
  }

  throw new RemoteUrlError("Remote URL redirected too many times");
}
