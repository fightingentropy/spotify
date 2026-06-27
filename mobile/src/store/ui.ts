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
  // When the song is opened from an editable playlist, offer "Remove from this
  // playlist". Carried so the global TrackActionsMenu can act without prop-drilling.
  playlist?: { id: string; name: string };
} | null;

// A generic name-input dialog reused for Create playlist + Rename playlist.
export type NamePromptTarget = {
  title: string;
  initialValue: string;
  confirmLabel: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
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
  librarySortOpen: boolean;
  // The song collection whose sort sheet is open (e.g. "liked", "playlist:<id>",
  // "downloads"), or null when closed. Carried so the global SongSortMenu edits
  // the right collection's persisted order.
  songSortContext: string | null;
  trackActions: TrackActionsTarget;
  libraryActions: LibraryActionsTarget;
  // The song being added to a playlist (drives AddToPlaylistSheet), or null.
  addToPlaylistSong: PlayerSong | null;
  namePrompt: NamePromptTarget;
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
  openLibrarySort: () => void;
  closeLibrarySort: () => void;
  openSongSort: (context: string) => void;
  closeSongSort: () => void;
  openTrackActions: (target: NonNullable<TrackActionsTarget>) => void;
  closeTrackActions: () => void;
  openLibraryActions: (target: NonNullable<LibraryActionsTarget>) => void;
  closeLibraryActions: () => void;
  openAddToPlaylist: (song: PlayerSong) => void;
  closeAddToPlaylist: () => void;
  openNamePrompt: (target: NonNullable<NamePromptTarget>) => void;
  closeNamePrompt: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  nowPlayingOpen: false,
  queueOpen: false,
  sleepTimerOpen: false,
  profileMenuOpen: false,
  createMenuOpen: false,
  librarySortOpen: false,
  songSortContext: null,
  trackActions: null,
  libraryActions: null,
  addToPlaylistSong: null,
  namePrompt: null,
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
  openLibrarySort: () => set({ librarySortOpen: true }),
  closeLibrarySort: () => set({ librarySortOpen: false }),
  openSongSort: (context) => set({ songSortContext: context }),
  closeSongSort: () => set({ songSortContext: null }),
  openTrackActions: (target) => set({ trackActions: target }),
  closeTrackActions: () => set({ trackActions: null }),
  openLibraryActions: (target) => set({ libraryActions: target }),
  closeLibraryActions: () => set({ libraryActions: null }),
  openAddToPlaylist: (song) => set({ addToPlaylistSong: song }),
  closeAddToPlaylist: () => set({ addToPlaylistSong: null }),
  openNamePrompt: (target) => set({ namePrompt: target }),
  closeNamePrompt: () => set({ namePrompt: null }),
}));
