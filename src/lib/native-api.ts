import { OFFLINE_PLAYBACK_SEARCH_PARAM } from "@/lib/player-song";

export const NATIVE_API_ORIGIN = "https://spotify.fightingentropy.org";

function urlBase(): string {
  return typeof window !== "undefined" ? window.location.href : "http://localhost/";
}

export function shouldRewriteNativeApiUrl(value: string, base = urlBase()): boolean {
  // capacitor:// is NOT excluded here: absolute same-origin API URLs (e.g. the
  // download pump's resolveUrl output, capacitor://localhost/api/...) must be
  // rewritten to the remote origin or they 404 against the local app shell.
  // Native file URLs (capacitor://localhost/_capacitor_file_/...) stay local
  // because their pathname never starts with /api/.
  if (!value || /^(blob:|data:|file:)/i.test(value)) return false;
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
