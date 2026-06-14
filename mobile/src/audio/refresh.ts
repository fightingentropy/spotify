// Signed-URL robustness, shared by both audio backends. A track's audioUrl is a
// short-lived signed URL; re-fetching the song catches an expired/rotated URL
// before the player wedges on a 403. Extracted verbatim from the original
// engine.ts so engine-rntp and engine-native share one implementation.

import { toAbsoluteApiUrl } from "@/lib/config";
import { apiFetch } from "@/lib/http";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { removeLocalPlaybackState } from "@/lib/playback-state";
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

const refreshNotFound: Record<string, number> = {};

export function clearStaleCurrentSong(): void {
  removeLocalPlaybackState();
  usePlayerStore.getState().setQueue([], 0);
  usePlayerStore.getState().pause();
}

// Refetch the current song to catch expired signed URLs (fire-and-forget).
export async function refreshCurrentSong(song: PlayerSong): Promise<void> {
  if (isOwnHandledSong(song) || isPodcastSong(song)) return;
  try {
    const response = await apiFetch(`/api/songs/${encodeURIComponent(song.id)}`, { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      clearStaleCurrentSong();
      return;
    }
    if (response.status === 404) {
      refreshNotFound[song.id] = (refreshNotFound[song.id] ?? 0) + 1;
      if (refreshNotFound[song.id] >= 2) clearStaleCurrentSong(); // only after 2 (deploy/proxy hiccup)
      return;
    }
    if (!response.ok) return;
    refreshNotFound[song.id] = 0;
    const fresh = (await response.json()) as PlayerSong;
    if (fresh?.id === song.id && fresh.audioUrl) usePlayerStore.getState().replaceSong(fresh);
  } catch {
    // network error — leave the current source alone
  }
}
