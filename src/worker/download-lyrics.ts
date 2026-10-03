import { readLyricsJson, type LyricsLookupOptions } from "@/lib/download-lyrics";
import { canUseMacMiniProxy, fetchMacMini, type MacMiniProxyEnv, type MacMiniProxyUser } from "./mac-mini-proxy";

/** Lyric providers can reject datacenter egress; use our signed private host first. */
export async function fetchMiniDownloadLyrics(
  env: MacMiniProxyEnv,
  user: MacMiniProxyUser | null,
  title: string,
  artist: string,
  options: LyricsLookupOptions,
  proxy = fetchMacMini,
): Promise<string> {
  if (!user || !canUseMacMiniProxy(env)) return "";
  try {
    const response = await proxy({
      env,
      target: "/api/downloads/lyrics",
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, artist, album: options.album, durationMs: options.durationMs, titleFallback: options.titleFallback }),
      signal: AbortSignal.timeout(35_000),
      // workerd supports manual/follow; reject 3xx via response.ok below.
      redirect: "manual",
    });
    if (!response.ok) { await response.body?.cancel(); return ""; }
    const value = await readLyricsJson(response, 512 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const lyrics = (value as Record<string, unknown>).lyrics;
    return typeof lyrics === "string" ? lyrics.trim() : "";
  } catch { return ""; }
}
