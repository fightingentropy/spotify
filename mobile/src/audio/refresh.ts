// Signed-URL robustness, shared by both audio backends. A track's audioUrl is a
// short-lived signed URL; re-fetching the song catches an expired/rotated URL
// before the player wedges on a 403. Extracted verbatim from the original
// engine.ts so engine-rntp and engine-native share one implementation.

import { toAbsoluteApiUrl } from "@/lib/config";
import { apiFetch } from "@/lib/http";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

export const MAX_CONSECUTIVE_AUDIO_ERRORS = 3;

// Radio / offline / local / picked-file sources manage their own URLs — never
// refresh or clear them as if they were signed library tracks.
export function isOwnHandledSong(song: PlayerSong): boolean {
  return (
    isRadioSong(song) ||
    song.source === "offline" ||
    song.source === "browser-local" ||
    song.source === "picked-file"
  );
}

// Per-song count of consecutive failed refreshes (auth-forbidden or not-found).
const refreshFailures: Record<string, number> = {};

// Refetch the current song to catch expired signed URLs (fire-and-forget).
export async function refreshCurrentSong(song: PlayerSong): Promise<void> {
  if (isOwnHandledSong(song) || isPodcastSong(song)) return;
  try {
    const response = await apiFetch(`/api/songs/${encodeURIComponent(song.id)}`, { cache: "no-store" });
    // 401/403 (auth-forbidden) or 404 (gone) → we can't get a fresh signed URL.
    // Tolerate a single transient failure (token blip / deploy/proxy hiccup), then
    // SKIP past the track instead of wiping the queue + deleting the saved resume
    // snapshot (the old clearStaleCurrentSong, which lost the whole queue + cross-
    // device state on ONE bad response). The rest of the queue + snapshot survive,
    // so a reconnect/relaunch recovers; next() respects offline/repeat and stops
    // cleanly with the queue intact when nothing else is playable, and the engine's
    // consecutive-error guard backstops a fully-dead session.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      refreshFailures[song.id] = (refreshFailures[song.id] ?? 0) + 1;
      if (refreshFailures[song.id] >= 2) {
        refreshFailures[song.id] = 0;
        usePlayerStore.getState().next();
      }
      return;
    }
    if (!response.ok) return;
    refreshFailures[song.id] = 0;
    const fresh = (await response.json()) as PlayerSong;
    if (fresh?.id === song.id && fresh.audioUrl) usePlayerStore.getState().replaceSong(fresh);
  } catch {
    // network error — leave the current source alone
  }
}
