import { isUnstagedDiscoverSong } from "@/lib/discover-placeholder";
import { isSameLogicalPlaybackSong } from "@/lib/staged-song-replacement";
import type { PlayerSong } from "@/types/player";

export type SongPlaybackState = "idle" | "loading" | "playing" | "paused";

type PlaybackSnapshot = { currentSong: PlayerSong | null; isPlaying: boolean };

// Play was requested but no audio is coming out yet: the source is still being
// staged on the server (a placeholder with no URL, which can take ~20 s), or the
// engine is buffering the current track. Transport controls show a spinner
// instead of a Pause glyph that claims audio is playing.
export function isAwaitingAudio(state: PlaybackSnapshot, bufferingSongId: string | null): boolean {
  const song = state.currentSong;
  if (!state.isPlaying || !song) return false;
  return isUnstagedDiscoverSong(song) || song.id === bufferingSongId;
}

// Row state for a song in a list. Rows match the current song logically so a
// staged placeholder keeps its highlight after the real id is swapped in.
export function songPlaybackState(
  state: PlaybackSnapshot,
  song: PlayerSong,
  bufferingSongId: string | null,
): SongPlaybackState {
  if (!isSameLogicalPlaybackSong(state.currentSong, song)) return "idle";
  if (!state.isPlaying) return "paused";
  return isAwaitingAudio(state, bufferingSongId) ? "loading" : "playing";
}
