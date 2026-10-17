import { create } from "zustand";
import { isAwaitingAudio, songPlaybackState, type SongPlaybackState } from "@/lib/playback-loading";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// The song the active audio backend is still buffering, or null once audio flows.
// engine-rntp feeds it from Track Player's Loading/Buffering states on Android;
// engine-native from the active deck's waiting/playing events on iOS.
const useBufferingStore = create<{ songId: string | null }>(() => ({ songId: null }));

export function setBufferingSong(songId: string | null): void {
  if (useBufferingStore.getState().songId !== songId) useBufferingStore.setState({ songId });
}

// True while the current song should be playing but no audio has started yet.
export function useIsAwaitingAudio(): boolean {
  const bufferingSongId = useBufferingStore((s) => s.songId);
  return usePlayerStore((s) => isAwaitingAudio(s, bufferingSongId));
}

// One narrow subscription per list row: only the rows whose state changes re-render.
export function useSongPlaybackState(song: PlayerSong): SongPlaybackState {
  const bufferingSongId = useBufferingStore((s) => s.songId);
  return usePlayerStore((s) => songPlaybackState(s, song, bufferingSongId));
}
