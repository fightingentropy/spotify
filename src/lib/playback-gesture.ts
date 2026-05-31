import type { PlayerSong } from "@/types/player";
import { resolveOfflinePlaybackSong } from "@/client/offline";

export const PLAYBACK_GESTURE_EVENT = "spotify:playback-gesture";

export type PlaybackGestureDetail = {
  audioUrl: string;
};

export function requestImmediatePlayback(song: PlayerSong | null | undefined): void {
  if (typeof window === "undefined" || !song?.audioUrl) return;
  const playbackSong = resolveOfflinePlaybackSong(song);
  if (!playbackSong?.audioUrl) return;
  window.dispatchEvent(
    new CustomEvent<PlaybackGestureDetail>(PLAYBACK_GESTURE_EVENT, {
      detail: { audioUrl: playbackSong.audioUrl },
    }),
  );
}
