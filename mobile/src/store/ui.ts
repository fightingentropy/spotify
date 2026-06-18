import type { ReactNode } from "react";
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

// Long-press actions for a Your Library row (pin / unpin). `cover` is the same
// size-aware render fn LibraryScreen builds, reused for the sheet's header art.
export type LibraryActionsTarget = {
  key: string;
  title: string;
  subtitle: string;
  cover: (size: number) => ReactNode;
} | null;

type UiState = {
  nowPlayingOpen: boolean;
  queueOpen: boolean;
  sleepTimerOpen: boolean;
  profileMenuOpen: boolean;
  createMenuOpen: boolean;
  trackActions: TrackActionsTarget;
  libraryActions: LibraryActionsTarget;
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
  openLibraryActions: (target: NonNullable<LibraryActionsTarget>) => void;
  closeLibraryActions: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  nowPlayingOpen: false,
  queueOpen: false,
  sleepTimerOpen: false,
  profileMenuOpen: false,
  createMenuOpen: false,
  trackActions: null,
  libraryActions: null,
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
  openLibraryActions: (target) => set({ libraryActions: target }),
  closeLibraryActions: () => set({ libraryActions: null }),
}));
