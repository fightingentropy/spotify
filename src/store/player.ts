"use client";

import { create } from "zustand";
import type { PlayerSong } from "@/types/player";

export type { PlayerSong } from "@/types/player";

type PlayerState = {
  queue: PlayerSong[];
  currentIndex: number; // index in queue
  currentSong: PlayerSong | null;
  playHistory: number[];
  playFuture: number[];
  isPlaying: boolean;
  volume: number; // 0..1
  isMuted: boolean;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  crossfadeEnabled: boolean;
  crossfadeSeconds: number; // 0..12
  setQueue: (songs: PlayerSong[], startIndex: number) => void;
  setSong: (song: PlayerSong | null) => void;
  advanceToIndex: (index: number) => void;
  replaceSong: (song: PlayerSong) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setCrossfadeEnabled: (enabled: boolean) => void;
  setCrossfadeSeconds: (seconds: number) => void;
};

const MAX_PLAY_HISTORY = 200;
const SHUFFLE_STORAGE_KEY = "spotify_shuffle_enabled";

function readStoredShuffle(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(SHUFFLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredShuffle(enabled: boolean): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(SHUFFLE_STORAGE_KEY, enabled ? "1" : "0");
    }
  } catch {}
}

function pushHistory(history: number[], index: number): number[] {
  if (!Number.isInteger(index) || index < 0) return history;
  return [...history, index].slice(-MAX_PLAY_HISTORY);
}

function randomQueueIndex(queueLength: number, currentIndex: number): number {
  if (queueLength <= 1) return currentIndex;
  let index = currentIndex;
  while (index === currentIndex) {
    index = Math.floor(Math.random() * queueLength);
  }
  return index;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  playHistory: [],
  playFuture: [],
  isPlaying: false,
  volume: 0.9,
  isMuted: false,
  shuffle: readStoredShuffle(),
  repeatMode: "off",
  // Initialize deterministic values to avoid SSR/CSR hydration mismatch; rehydrate from localStorage on client mount
  crossfadeEnabled: true,
  crossfadeSeconds: 4,
  setQueue: (songs, startIndex) =>
    set(() => ({
      queue: songs,
      currentIndex: startIndex,
      currentSong: songs[startIndex] ?? null,
      playHistory: [],
      playFuture: [],
      isPlaying: true,
    })),
  setSong: (song) => set({ currentSong: song, playHistory: [], playFuture: [] }),
  advanceToIndex: (index) =>
    set((s) => {
      if (index < 0 || index >= s.queue.length || index === s.currentIndex) return s;
      return {
        ...s,
        currentIndex: index,
        currentSong: s.queue[index],
        playHistory: s.shuffle ? pushHistory(s.playHistory, s.currentIndex) : s.playHistory,
        playFuture: s.shuffle ? [] : s.playFuture,
        isPlaying: true,
      };
    }),
  replaceSong: (song) =>
    set((s) => {
      const queue = s.queue.map((item) => (item.id === song.id ? song : item));
      return {
        queue,
        currentSong: s.currentSong?.id === song.id ? song : s.currentSong,
      };
    }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
  next: () =>
    set((s) => {
      if (s.queue.length === 0) return s.isPlaying ? { ...s, isPlaying: false } : s;
      if (s.shuffle) {
        if (s.queue.length === 1) {
          return s.repeatMode === "all"
            ? { ...s, currentIndex: 0, currentSong: s.queue[0], isPlaying: true }
            : { ...s, isPlaying: false };
        }
        const future = s.playFuture.slice();
        const idx = future.length > 0 ? future.pop() ?? s.currentIndex : randomQueueIndex(s.queue.length, s.currentIndex);
        if (idx === s.currentIndex) return s;
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          playHistory: pushHistory(s.playHistory, s.currentIndex),
          playFuture: future,
          isPlaying: true,
        };
      }
      const atEnd = s.currentIndex >= s.queue.length - 1;
      if (atEnd) {
        if (s.repeatMode === "all") {
          return { ...s, currentIndex: 0, currentSong: s.queue[0], isPlaying: true };
        }
        // repeat one handled in PlayerBar; here stop at end for off
        return { ...s, isPlaying: false };
      }
      const idx = s.currentIndex + 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    }),
  previous: () =>
    set((s) => {
      if (s.queue.length === 0) return s;
      if (s.shuffle) {
        const history = s.playHistory.slice();
        const idx = history.pop();
        if (idx === undefined || idx < 0 || idx >= s.queue.length) return s;
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          playHistory: history,
          playFuture: pushHistory(s.playFuture, s.currentIndex),
          isPlaying: true,
        };
      }
      const atStart = s.currentIndex <= 0;
      if (atStart) {
        if (s.repeatMode === "all") {
          const idx = s.queue.length - 1;
          return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
        }
        return s;
      }
      const idx = s.currentIndex - 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    }),
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  toggleShuffle: () =>
    set((s) => {
      const shuffle = !s.shuffle;
      writeStoredShuffle(shuffle);
      return { shuffle, playHistory: [], playFuture: [] };
    }),
  cycleRepeatMode: () =>
    set((s) => ({ repeatMode: s.repeatMode === "off" ? "all" : s.repeatMode === "all" ? "one" : "off" })),
  setCrossfadeEnabled: (enabled) => {
    try { if (typeof window !== "undefined") localStorage.setItem("spotify_crossfade_enabled", enabled ? "1" : "0"); } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try { if (typeof window !== "undefined") localStorage.setItem("spotify_crossfade_seconds", String(clamped)); } catch {}
    set({ crossfadeSeconds: clamped });
  },
}));
