import type { PlayerSong } from "@/types/player";
import { prepareHistorySongForPlayback, stageDiscoverSong } from "./discover-queue";

export function playbackFailureMessage(error?: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline. Reconnect, then retry this song.";
  return error instanceof Error ? error.message : "This song couldn't load. Retry it or choose another song.";
}

export async function refreshPlaybackSong(song: PlayerSong): Promise<PlayerSong> {
  const prepared = prepareHistorySongForPlayback(song);
  if (prepared.discoverTrackId && (!prepared.audioUrl || prepared.audioUrl.includes("/.discover/"))) {
    return stageDiscoverSong(prepared);
  }
  if (song.source === "podcast" || song.id.startsWith("podcast:")) {
    const url = new URL(song.audioUrl, window.location.origin);
    url.searchParams.set("__retry", String(Date.now()));
    return { ...song, audioUrl: url.href };
  }
  const response = await fetch(`/api/songs/${encodeURIComponent(song.id)}`, {
    credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error("Your session expired. Sign in again to play this song.");
  if (response.status === 404) throw new Error("This song is no longer available. Choose another song or restore its file.");
  if (!response.ok) throw new Error("The music server couldn't load this song. Try again in a moment.");
  const fresh = await response.json() as PlayerSong;
  if (fresh.id !== song.id || !fresh.audioUrl) throw new Error("This song couldn't load. Retry it or choose another song.");
  return fresh;
}
