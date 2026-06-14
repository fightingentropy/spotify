import { usePlayerStore } from "@/store/player";
import { seek } from "@/audio/engine";
import type { PlayerSong } from "@/types/player";

// High-level playback actions the UI calls. The store is the single source of
// truth for queue/order; the engine reacts to store changes and drives the
// active audio backend (native dual-deck on iOS, RNTP elsewhere).

export function playSongs(songs: PlayerSong[], startIndex: number, options?: { respectShuffle?: boolean }): void {
  usePlayerStore.getState().setQueue(songs, startIndex, options);
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
  state.setQueue(songs, startIndex);
}

export async function seekTo(seconds: number): Promise<void> {
  await seek(Math.max(0, seconds));
}
