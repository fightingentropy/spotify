import { create } from "zustand";
import type { PlayerSong } from "@/types/player";

// UI state for the three global bottom sheets (Now Playing, Queue, Track Actions)
// plus the sleep-timer sheet and the left profile drawer. Kept separate from the
// player store.
export type TrackActionsTarget = {
  song: PlayerSong;
  canLike: boolean;
  showLike: boolean;
} | null;

type UiState = {
  nowPlayingOpen: boolean;
  queueOpen: boolean;
  sleepTimerOpen: boolean;
  profileMenuOpen: boolean;
  createMenuOpen: boolean;
  trackActions: TrackActionsTarget;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  openQueue: () => void;
  closeQueue: () => void;
  openSleepTimer: () => void;
  closeSleepTimer: () => void;
  openProfileMenu: () => void;
  closeProfileMenu: () => void;
  openCreateMenu: () => void;
  closeCreateMenu: () => void;
  openTrackActions: (target: NonNullable<TrackActionsTarget>) => void;
  closeTrackActions: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  nowPlayingOpen: false,
  queueOpen: false,
  sleepTimerOpen: false,
  profileMenuOpen: false,
  createMenuOpen: false,
  trackActions: null,
  openNowPlaying: () => set({ nowPlayingOpen: true }),
  closeNowPlaying: () => set({ nowPlayingOpen: false }),
  openQueue: () => set({ queueOpen: true }),
  closeQueue: () => set({ queueOpen: false }),
  openSleepTimer: () => set({ sleepTimerOpen: true }),
  closeSleepTimer: () => set({ sleepTimerOpen: false }),
  openProfileMenu: () => set({ profileMenuOpen: true }),
  closeProfileMenu: () => set({ profileMenuOpen: false }),
  openCreateMenu: () => set({ createMenuOpen: true }),
  closeCreateMenu: () => set({ createMenuOpen: false }),
  openTrackActions: (target) => set({ trackActions: target }),
  closeTrackActions: () => set({ trackActions: null }),
}));
