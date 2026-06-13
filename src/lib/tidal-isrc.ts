// Resolve a Tidal track id from an ISRC via Tidal's official OpenAPI. This lets
// the Hi-Res spotbye Tidal source (which keys on a Tidal track id) be used even
// when the resolver only produced an ISRC. Mirrors how the Spotiflac app gets
// the Tidal id, but uses Tidal directly instead of Odesli (no rate-limit risk).

const TIDAL_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const TIDAL_OPENAPI_BASE = "https://openapi.tidal.com/v2";
// Tidal OpenAPI client-credentials (public demo app). If Tidal rotates these,
// update them here — the source will fall back to lossy/skip until then.
const TIDAL_CLIENT_ID = "txNoH4kkV41MfH25";
const TIDAL_CLIENT_SECRET = "dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=";
const TIDAL_REQUEST_TIMEOUT_MS = 15_000;

let tidalTokenCache: { token: string; expiresAtMs: number } | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIDAL_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTidalAccessToken(): Promise<string> {
  if (tidalTokenCache && tidalTokenCache.expiresAtMs > Date.now()) {
    return tidalTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: TIDAL_CLIENT_ID,
    client_secret: TIDAL_CLIENT_SECRET,
  });
  const response = await fetchWithTimeout(TIDAL_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response?.ok) return "";
  const payload = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  const token = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (!token) return "";
  const expiresIn = typeof payload?.expires_in === "number" ? payload.expires_in : 3600;
  tidalTokenCache = { token, expiresAtMs: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
  return token;
}

// Returns a Tidal track id (preferring a LOSSLESS release) for the given ISRC,
// or "" if Tidal is unavailable / has no match.
export async function resolveTidalTrackIdByIsrc(isrc: string, region: string): Promise<string> {
  if (!isrc) return "";
  const token = await fetchTidalAccessToken();
  if (!token) return "";
  const country = (region || "US").toUpperCase();
  const url = `${TIDAL_OPENAPI_BASE}/tracks?countryCode=${encodeURIComponent(country)}&filter%5Bisrc%5D=${encodeURIComponent(isrc)}`;
  const response = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.api+json" },
  });
  if (!response?.ok) return "";
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const data = Array.isArray(payload?.data) ? payload.data : [];
  let fallback = "";
  for (const entry of data) {
    const item = entry as { id?: unknown; attributes?: { mediaTags?: unknown } } | null;
    const id = typeof item?.id === "string" ? item.id : typeof item?.id === "number" ? String(item.id) : "";
    if (!/^\d+$/.test(id)) continue;
    if (!fallback) fallback = id;
    const tags = item?.attributes?.mediaTags;
    if (Array.isArray(tags) && tags.includes("LOSSLESS")) return id;
  }
  return fallback;
}
