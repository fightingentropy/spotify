/** Bounded lyrics lookup with a deliberate, optional title-search fallback. */
export type LyricsLookupOptions = { titleFallback?: boolean; durationMs?: number; album?: string };
type Candidate = { text: string; score: number; complete: boolean };
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const normalized = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Read lyric metadata without allowing an upstream or caller to buffer an unlimited body. */
export async function readLyricsJson(message: Pick<Request | Response, "body">, maxBytes: number): Promise<unknown> {
  if (!message.body) throw new Error("Missing lyrics response body");
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Lyrics response is too large");
      }
      raw += decoder.decode(part.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(raw + decoder.decode());
}
export function simplifiedLyricsTitle(title: string): string {
  return title.replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster|radio edit|single version|album version).*$/i, "").trim();
}
export function lyricsCompleteness(lyrics: string, durationMs = 0): { complete: boolean; score: number } {
  const lines = lyrics.split(/\r?\n/).filter(line => line.replace(/\[[^\]]*\]/g, "").trim());
  const timestamps = [...lyrics.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)]
    .map(match => (Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || "0"}`)) * 1000);
  const last = timestamps.length ? Math.max(...timestamps) : 0;
  const timed = timestamps.length > 0;
  const complete = timed ? lines.length >= 4 && (!durationMs || durationMs <= 45_000 || last >= durationMs * 0.55) : lines.length >= 6;
  return { complete, score: (complete ? 10_000 : 0) + (timed ? 1000 : 0) + Math.min(lines.length, 500) + Math.min(last / 1000, 999) };
}
function candidate(value: unknown, title: string, artist: string, options: LyricsLookupOptions, loose: boolean): Candidate | null {
  const row = object(value);
  if (!row) return null;
  const candidateTitle = text(row.trackName);
  if (candidateTitle && normalized(simplifiedLyricsTitle(candidateTitle)) !== normalized(simplifiedLyricsTitle(title))) return null;
  const expectedArtist = normalized(artist.split(/[,;]|\s+feat\.?\s+/i)[0]);
  const actualArtist = normalized(text(row.artistName));
  const artistMatches = !actualArtist || !expectedArtist || actualArtist.includes(expectedArtist) || expectedArtist.includes(actualArtist);
  const duration = typeof row.duration === "number" ? row.duration * 1000 : 0;
  const durationMatches = !!duration && !!options.durationMs && Math.abs(duration - options.durationMs) <= 6000;
  if (duration && options.durationMs && Math.abs(duration - options.durationMs) > Math.max(12_000, options.durationMs * 0.1)) return null;
  if (!artistMatches && (!loose || !durationMatches)) return null;
  const synced = text(row.syncedLyrics);
  const plain = text(row.plainLyrics);
  const candidates = [synced, plain].filter(Boolean).map(lyrics => ({ text: lyrics, ...lyricsCompleteness(lyrics, options.durationMs) }));
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best ? { ...best, score: best.score + (artistMatches ? 200 : 0) + (durationMatches ? 100 : 0) } : null;
}
export async function fetchLrclibLyrics(title: string, artist: string, options: LyricsLookupOptions = {}, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<string> {
  let best: Candidate | null = null;
  async function lookup(path: "get" | "search", queryTitle: string, queryArtist: string, loose = false): Promise<boolean> {
    const params = new URLSearchParams({ track_name: queryTitle });
    if (queryArtist) params.set("artist_name", queryArtist);
    if (path === "get") {
      if (options.album) params.set("album_name", options.album);
      if (options.durationMs) params.set("duration", String(Math.round(options.durationMs / 1000)));
    }
    try {
      const response = await fetcher(`https://lrclib.net/api/${path}?${params}`, {
        headers: { accept: "application/json", "user-agent": "StreamArenaMusic/1.0" },
        // workerd rejects redirect:"error" before issuing the request.
        // Manual mode plus the !ok check below rejects redirects safely.
        signal: AbortSignal.timeout(6000), redirect: "manual",
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); return false; }
      const payload = await readLyricsJson(response, 1024 * 1024);
      for (const row of Array.isArray(payload) ? payload.slice(0, 100) : [payload]) {
        const found = candidate(row, title, artist, options, loose);
        if (found && (!best || found.score > best.score)) best = found;
      }
      return best?.complete === true;
    } catch { return false; }
  }
  if (await lookup("get", title, artist)) return (best as Candidate | null)?.text || "";
  if (await lookup("search", title, artist)) return (best as Candidate | null)?.text || "";
  const simplified = simplifiedLyricsTitle(title);
  if (simplified && simplified !== title) {
    if (await lookup("get", simplified, artist)) return (best as Candidate | null)?.text || "";
    if (await lookup("search", simplified, artist)) return (best as Candidate | null)?.text || "";
  }
  if (options.titleFallback !== false) await lookup("search", simplified || title, "", true);
  return (best as Candidate | null)?.text || "";
}
