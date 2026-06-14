import { create } from "zustand";
import type { PlayerSong } from "@/types/player";

// UI state for the three global bottom sheets (Now Playing, Queue, Track Actions)
// plus the sleep-timer sheet. Kept separate from the player store.
export type TrackActionsTarget = {
  song: PlayerSong;
  canLike: boolean;
  showLike: boolean;
} | null;

type UiState = {
  nowPlayingOpen: boolean;
  queueOpen: boolean;
  sleepTimerOpen: boolean;
  trackActions: TrackActionsTarget;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  openQueue: () => void;
  closeQueue: () => void;
  openSleepTimer: () => void;
  closeSleepTimer: () => void;
  openTrackActions: (target: NonNullable<TrackActionsTarget>) => void;
  closeTrackActions: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  nowPlayingOpen: false,
  queueOpen: false,
  sleepTimerOpen: false,
  trackActions: null,
  openNowPlaying: () => set({ nowPlayingOpen: true }),
  closeNowPlaying: () => set({ nowPlayingOpen: false }),
  openQueue: () => set({ queueOpen: true }),
  closeQueue: () => set({ queueOpen: false }),
  openSleepTimer: () => set({ sleepTimerOpen: true }),
  closeSleepTimer: () => set({ sleepTimerOpen: false }),
  openTrackActions: (target) => set({ trackActions: target }),
  closeTrackActions: () => set({ trackActions: null }),
}));
