import type { PlayerSong } from "@/types/player";

export const PLAYBACK_STATE_VERSION = 1;
export const PLAYBACK_STATE_STORAGE_KEY = "spotify_player_state";
export const PLAYBACK_DEVICE_ID_STORAGE_KEY = "spotify_playback_device_id";

export type PlaybackStateSnapshot = {
  version: typeof PLAYBACK_STATE_VERSION;
  accountScope: string;
  queue: PlayerSong[];
  currentIndex: number;
  song: PlayerSong;
  currentTime: number;
  isPlaying: boolean;
  updatedAt: number;
  deviceId: string;
};
