// A saved preview can predate the fields that identify its staging request.
// Recover only the two directory formats our server creates, never arbitrary URLs.
export function discoverIdentity(payload: Record<string, unknown>, audioUrl: string) {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  let discoverTrackId = text(payload.discoverTrackId);
  let youtubeVideoId = text(payload.youtubeVideoId);
  let preview = payload.preview === true;
  let staged = payload.staged === true;
  try {
    const path = new URL(audioUrl, "https://music.invalid").pathname;
    const match = /^\/api\/files\/local\/\.discover\/(yt_[\w-]{11}|[a-zA-Z0-9]{22})\//.exec(path);
    if (match) {
      discoverTrackId ||= match[1];
      if (match[1].startsWith("yt_")) youtubeVideoId ||= match[1].slice(3);
      preview ||= /\.(opus|m4a|mp3)$/i.test(path);
      staged = true;
    }
  } catch { /* Non-URL sources have no recoverable staging identity. */ }
  return {
    discoverTrackId: discoverTrackId || undefined,
    youtubeVideoId: youtubeVideoId || undefined,
    preview: preview || undefined,
    staged: staged || undefined,
  };
}

export function mediaLinkExpired(audioUrl: string, now = Date.now()): boolean {
  try {
    const value = new URL(audioUrl, "https://music.invalid").searchParams.get("spotify_exp");
    const expiry = Number(value);
    return value !== null && Number.isFinite(expiry) && expiry * 1000 <= now;
  } catch { return false; }
}
