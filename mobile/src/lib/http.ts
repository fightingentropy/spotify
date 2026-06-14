import { API_ORIGIN } from "@/lib/config";

// Resolve an API path against the backend origin. Absolute URLs pass through.
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Low-level data fetch. Data/API calls authenticate with the session cookie, which
// RN's fetch persists in the native cookie store (NSHTTPCookieStorage /
// CookieManager) — see §2 of the port brief. Media streaming does NOT share this
// jar, which is why media URLs are signed instead.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { credentials: "include", ...init });
}
