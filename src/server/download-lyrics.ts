import { fetchLrclibLyrics, readLyricsJson } from "../lib/download-lyrics";
import { json } from "./local-http";

/** Called only after the server verifies its private-proxy envelope/local peer. */
export async function handleDownloadLyrics(
  request: Request,
  userId: string | null,
  lookup = fetchLrclibLyrics,
): Promise<Response> {
  if (!userId) return json({ error: "Unauthorized" }, { status: 401 });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const body = await readLyricsJson(request, 16 * 1024).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Invalid lyrics lookup" }, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const artist = typeof value.artist === "string" ? value.artist.trim() : "";
  const album = typeof value.album === "string" ? value.album.trim() : "";
  const durationMs = typeof value.durationMs === "number" ? value.durationMs : 0;
  if (!title || !artist || [title, artist, album].some(text => text.length > 512)
    || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
    return json({ error: "Invalid lyrics lookup" }, { status: 400 });
  }
  const lyrics = await lookup(title, artist, {
    album, durationMs, titleFallback: value.titleFallback !== false,
  });
  if (!lyrics.trim()) return json({ error: "Lyrics not found for this track" }, { status: 404 });
  if (new TextEncoder().encode(lyrics).byteLength > 256 * 1024) {
    return json({ error: "Lyrics response is too large" }, { status: 502 });
  }
  return json({ lyrics });
}
