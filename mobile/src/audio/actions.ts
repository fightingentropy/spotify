import { getIsOnline } from "@/lib/connectivity";
import { useOfflineStore } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { seek } from "@/audio/engine";
import type { PlayerSong } from "@/types/player";

// High-level playback actions the UI calls. The store is the single source of
// truth for queue/order; the engine reacts to store changes and drives the
// active audio backend (native dual-deck on iOS, RNTP elsewhere).

// When we're offline, start a list from only its downloaded songs so playback
// never flashes through tracks it can't stream — the queue itself holds only
// playable songs, so shuffle/auto-advance stay on them seamlessly. Online (the
// default) the list is untouched. Falls back to the full list when nothing is
// downloaded (the engine's reactive guard then stops cleanly) or when every
// song is already downloaded. `startIndex` is remapped to the requested song's
// new position, or to the start of the subset if that song isn't downloaded.
function playableQueue(songs: PlayerSong[], startIndex: number): { songs: PlayerSong[]; startIndex: number } {
  if (getIsOnline() || songs.length === 0) return { songs, startIndex };
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  const filtered = songs.filter((s) => isDownloaded(s.id));
  if (filtered.length === 0 || filtered.length === songs.length) return { songs, startIndex };
  const requested = songs[startIndex];
  const idx = requested ? filtered.findIndex((s) => s.id === requested.id) : -1;
  return { songs: filtered, startIndex: idx >= 0 ? idx : 0 };
}

export function playSongs(songs: PlayerSong[], startIndex: number, options?: { respectShuffle?: boolean }): void {
  const plan = playableQueue(songs, startIndex);
  usePlayerStore.getState().setQueue(plan.songs, plan.startIndex, options);
}

export function playSong(song: PlayerSong): void {
  usePlayerStore.getState().setQueue([song], 0);
}

// Tap a tile: toggle if it's already current, otherwise start it within its list.
export function toggleSongInList(songs: PlayerSong[], startIndex: number): void {
  const state = usePlayerStore.getState();
  const target = songs[startIndex];
  if (target && state.currentSong?.id === target.id) {
    state.toggle();
    return;
  }
  const plan = playableQueue(songs, startIndex);
  state.setQueue(plan.songs, plan.startIndex);
}

export async function seekTo(seconds: number): Promise<void> {
  await seek(Math.max(0, seconds));
}
