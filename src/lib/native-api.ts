import { OFFLINE_PLAYBACK_SEARCH_PARAM } from "@/lib/player-song";

export const NATIVE_API_ORIGIN = "https://spotify.fightingentropy.org";

function urlBase(): string {
  return typeof window !== "undefined" ? window.location.href : "http://localhost/";
}

export function shouldRewriteNativeApiUrl(value: string, base = urlBase()): boolean {
  if (!value || /^(blob:|data:|file:|capacitor:)/i.test(value)) return false;
  try {
    const url = new URL(value, base);
    if (!url.pathname.startsWith("/api/")) return false;
    return url.searchParams.get(OFFLINE_PLAYBACK_SEARCH_PARAM) !== "1";
  } catch {
    return false;
  }
}

export function rewriteNativeApiUrl(value: string, base = urlBase()): string {
  if (!shouldRewriteNativeApiUrl(value, base)) return value;
  try {
    const url = new URL(value, base);
    return `${NATIVE_API_ORIGIN}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}
