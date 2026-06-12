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
  shuffleRemaining: number[];
  isPlaying: boolean;
  volume: number; // 0..1
  isMuted: boolean;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  crossfadeEnabled: boolean;
  crossfadeSeconds: number; // 0..12
  playbackRate: number; // 0.5..3, applied to podcast playback only
  // In-memory only: a sleep timer should not survive a relaunch.
  sleepTimerEndsAt: number | null; // epoch ms
  sleepAtEndOfTrack: boolean;
  setQueue: (songs: PlayerSong[], startIndex: number, options?: SetQueueOptions) => PlayerSong | null;
  setSong: (song: PlayerSong | null) => void;
  advanceToIndex: (index: number, options?: AdvanceToIndexOptions) => void;
  replaceSong: (song: PlayerSong) => void;
  addToQueue: (song: PlayerSong) => void;
  playNext: (song: PlayerSong) => void;
  removeFromQueue: (index: number) => void;
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
  setPlaybackRate: (rate: number) => void;
  startSleepTimer: (minutes: number) => void;
  setSleepAtEndOfTrack: () => void;
  cancelSleepTimer: () => void;
};

type SetQueueOptions = {
  respectShuffle?: boolean;
};

type AdvanceToIndexOptions = {
  // True when the target index was peeked from playFuture (the redo stack), so
  // the commit should consume that entry rather than picking from the shuffle pool.
  fromFuture?: boolean;
};

const MAX_PLAY_HISTORY = 200;
const SHUFFLE_STORAGE_KEY = "spotify_shuffle_enabled";
const VOLUME_STORAGE_KEY = "spotify_volume";
const MUTED_STORAGE_KEY = "spotify_muted";
const REPEAT_MODE_STORAGE_KEY = "spotify_repeat_mode";
const CROSSFADE_ENABLED_STORAGE_KEY = "spotify_crossfade_enabled";
const CROSSFADE_SECONDS_STORAGE_KEY = "spotify_crossfade_seconds";
const PLAYBACK_RATE_STORAGE_KEY = "spotify_playback_rate";

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

function readStoredVolume(): number {
  try {
    if (typeof window === "undefined") return 0.9;
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return 0.9;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.9;
  } catch {
    return 0.9;
  }
}

function writeStoredVolume(value: number): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(VOLUME_STORAGE_KEY, String(value));
  } catch {}
}

function readStoredMuted(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMuted(muted: boolean): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

function readStoredRepeatMode(): PlayerState["repeatMode"] {
  try {
    if (typeof window === "undefined") return "off";
    const raw = localStorage.getItem(REPEAT_MODE_STORAGE_KEY);
    return raw === "one" || raw === "all" || raw === "off" ? raw : "off";
  } catch {
    return "off";
  }
}

function writeStoredRepeatMode(mode: PlayerState["repeatMode"]): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(REPEAT_MODE_STORAGE_KEY, mode);
  } catch {}
}

function readStoredCrossfadeEnabled(): boolean {
  try {
    if (typeof window === "undefined") return true;
    const raw = localStorage.getItem(CROSSFADE_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function readStoredCrossfadeSeconds(): number {
  try {
    if (typeof window === "undefined") return 4;
    const raw = localStorage.getItem(CROSSFADE_SECONDS_STORAGE_KEY);
    return Math.max(0, Math.min(12, Number(raw ?? 4)));
  } catch {
    return 4;
  }
}

function readStoredPlaybackRate(): number {
  try {
    if (typeof window === "undefined") return 1;
    const raw = localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0.5, Math.min(3, value)) : 1;
  } catch {
    return 1;
  }
}

// Tap-to-cycle order for the podcast speed chip.
export const PLAYBACK_RATE_CYCLE = [1, 1.25, 1.5, 1.75, 2, 0.75];

export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATE_CYCLE.indexOf(rate);
  return PLAYBACK_RATE_CYCLE[(index + 1) % PLAYBACK_RATE_CYCLE.length];
}

export function formatPlaybackRate(rate: number): string {
  return `${rate}×`;
}

function pushHistory(history: number[], index: number): number[] {
  if (!Number.isInteger(index) || index < 0) return history;
  return [...history, index].slice(-MAX_PLAY_HISTORY);
}

function clampQueueIndex(queueLength: number, index: number): number {
  if (queueLength <= 0) return -1;
  if (!Number.isInteger(index)) return 0;
  return Math.max(0, Math.min(queueLength - 1, index));
}

function randomQueueIndex(queueLength: number, currentIndex: number): number {
  if (queueLength <= 0) return -1;
  if (queueLength <= 1) return 0;
  let index = currentIndex;
  while (index === currentIndex) {
    index = Math.floor(Math.random() * queueLength);
  }
  return index;
}

function resolveQueueStartIndex(queueLength: number, startIndex: number, useShuffleStart: boolean): number {
  if (queueLength <= 0) return -1;
  return useShuffleStart ? randomQueueIndex(queueLength, -1) : clampQueueIndex(queueLength, startIndex);
}

function createShuffleRemaining(queueLength: number, currentIndex: number): number[] {
  if (queueLength <= 1) return [];
  const current = clampQueueIndex(queueLength, currentIndex);
  const remaining: number[] = [];
  for (let index = 0; index < queueLength; index += 1) {
    if (index !== current) remaining.push(index);
  }
  return remaining;
}

function validShuffleRemaining(queueLength: number, currentIndex: number, remaining: number[]): number[] {
  if (queueLength <= 1) return [];
  const seen = new Set<number>();
  return remaining.filter((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= queueLength || index === currentIndex) return false;
    if (seen.has(index)) return false;
    seen.add(index);
    return true;
  });
}

function removeQueueIndex(indices: number[], indexToRemove: number): number[] {
  return indices.filter((index) => index !== indexToRemove);
}

// Remap stored queue indices (playHistory / playFuture / shuffleRemaining) when
// the queue array shifts: an insertion at `pivot` pushes indices >= pivot up by
// one; a removal at `pivot` drops that entry and pulls indices > pivot down by
// one. Skipping this silently corrupts shuffle and back/forward navigation.
function remapQueueIndices(indices: number[], pivot: number, delta: 1 | -1): number[] {
  const remapped: number[] = [];
  for (const index of indices) {
    if (delta === -1) {
      if (index === pivot) continue;
      remapped.push(index > pivot ? index - 1 : index);
    } else {
      remapped.push(index >= pivot ? index + 1 : index);
    }
  }
  return remapped;
}

export function getNextShufflePool(queueLength: number, currentIndex: number, remaining: number[]): number[] {
  const validRemaining = validShuffleRemaining(queueLength, currentIndex, remaining);
  return validRemaining.length > 0 ? validRemaining : createShuffleRemaining(queueLength, currentIndex);
}

export function chooseNextShuffleIndex(queueLength: number, currentIndex: number, remaining: number[]): number {
  const pool = getNextShufflePool(queueLength, currentIndex, remaining);
  if (pool.length === 0) return clampQueueIndex(queueLength, currentIndex);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function sleepTimerRemainingMinutes(endsAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  playHistory: [],
  playFuture: [],
  shuffleRemaining: [],
  isPlaying: false,
  volume: readStoredVolume(),
  isMuted: readStoredMuted(),
  shuffle: readStoredShuffle(),
  repeatMode: readStoredRepeatMode(),
  // Lazy initializers read persisted values on the client and fall back to
  // deterministic SSR defaults (true / 4) so there's no hydration mismatch.
  // This is the single source of truth for crossfade hydration.
  crossfadeEnabled: readStoredCrossfadeEnabled(),
  crossfadeSeconds: readStoredCrossfadeSeconds(),
  playbackRate: readStoredPlaybackRate(),
  sleepTimerEndsAt: null,
  sleepAtEndOfTrack: false,
  setQueue: (songs, startIndex, options) => {
    const start = resolveQueueStartIndex(
      songs.length,
      startIndex,
      options?.respectShuffle === true && get().shuffle,
    );
    const currentSong = start >= 0 ? songs[start] ?? null : null;
    set(() => ({
      queue: songs,
      currentIndex: start,
      currentSong,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: get().shuffle ? createShuffleRemaining(songs.length, start) : [],
      isPlaying: currentSong != null,
    }));
    return currentSong;
  },
  setSong: (song) =>
    set({
      currentSong: song,
      queue: song ? [song] : [],
      currentIndex: song ? 0 : -1,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: [],
    }),
  advanceToIndex: (index, options) =>
    set((s) => {
      if (index < 0 || index >= s.queue.length || index === s.currentIndex) return s;
      if (!s.shuffle) {
        return {
          ...s,
          currentIndex: index,
          currentSong: s.queue[index],
          isPlaying: true,
        };
      }
      // Mirror next()'s shuffle bookkeeping: when the target came from playFuture
      // (redo stack), consume that one entry and leave shuffleRemaining untouched;
      // otherwise treat it as a fresh pick, which only happens when playFuture is
      // empty, so the redo stack ends up cleared just like next().
      const future = s.playFuture.slice();
      const fromFuture = options?.fromFuture === true && future[future.length - 1] === index;
      return {
        ...s,
        currentIndex: index,
        currentSong: s.queue[index],
        playHistory: pushHistory(s.playHistory, s.currentIndex),
        playFuture: fromFuture ? future.slice(0, -1) : [],
        shuffleRemaining: fromFuture ? s.shuffleRemaining : removeQueueIndex(s.shuffleRemaining, index),
        isPlaying: true,
      };
    }),
  replaceSong: (song) =>
    set((s) => {
      // Preserve the original queue array reference when nothing actually
      // changed, so consumers keying off queue identity (e.g. prefetch
      // effects) don't re-run on every refresh of the current song.
      const matchIndex = s.queue.findIndex((item) => item.id === song.id);
      if (matchIndex < 0) {
        return s.currentSong?.id === song.id ? { currentSong: song } : s;
      }
      const queue = s.queue.slice();
      queue[matchIndex] = song;
      return {
        queue,
        currentSong: s.currentSong?.id === song.id ? song : s.currentSong,
      };
    }),
  addToQueue: (song) =>
    set((s) => {
      const queue = [...s.queue, song];
      const appendedIndex = queue.length - 1;
      if (s.currentIndex < 0) {
        // Empty queue: make the song current but leave playback paused.
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
        };
      }
      return {
        queue,
        shuffleRemaining: s.shuffle ? [...s.shuffleRemaining, appendedIndex] : s.shuffleRemaining,
      };
    }),
  playNext: (song) =>
    set((s) => {
      if (s.currentIndex < 0) {
        const queue = [...s.queue, song];
        return {
          queue,
          currentIndex: 0,
          currentSong: queue[0],
        };
      }
      const insertAt = s.currentIndex + 1;
      const queue = s.queue.slice();
      queue.splice(insertAt, 0, song);
      return {
        queue,
        playHistory: remapQueueIndices(s.playHistory, insertAt, 1),
        // Shuffle consults playFuture before drawing from the shuffle pool
        // (next() pops it and the crossfade target peeks it), so pushing the
        // inserted index there makes "play next" hold under shuffle too.
        // Linear mode reads currentIndex + 1 directly and ignores playFuture.
        playFuture: s.shuffle
          ? [...remapQueueIndices(s.playFuture, insertAt, 1), insertAt]
          : remapQueueIndices(s.playFuture, insertAt, 1),
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, insertAt, 1),
      };
    }),
  removeFromQueue: (index) =>
    set((s) => {
      if (!Number.isInteger(index) || index < 0 || index >= s.queue.length || index === s.currentIndex) {
        return s;
      }
      const queue = s.queue.slice();
      queue.splice(index, 1);
      return {
        queue,
        currentIndex: index < s.currentIndex ? s.currentIndex - 1 : s.currentIndex,
        playHistory: remapQueueIndices(s.playHistory, index, -1),
        playFuture: remapQueueIndices(s.playFuture, index, -1),
        shuffleRemaining: remapQueueIndices(s.shuffleRemaining, index, -1),
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
        const idxFromFuture = future.pop();
        if (idxFromFuture === undefined) {
          // When the shuffle pool is exhausted, only refill if repeat "all" is
          // on; otherwise stop at the end of the shuffle cycle, mirroring linear
          // mode's behavior with repeat "off".
          const remaining = validShuffleRemaining(s.queue.length, s.currentIndex, s.shuffleRemaining);
          if (remaining.length === 0 && s.repeatMode !== "all") {
            return s.isPlaying ? { ...s, isPlaying: false } : s;
          }
        }
        const shufflePool =
          idxFromFuture === undefined
            ? getNextShufflePool(s.queue.length, s.currentIndex, s.shuffleRemaining)
            : s.shuffleRemaining;
        const idx =
          idxFromFuture === undefined
            ? shufflePool[Math.floor(Math.random() * shufflePool.length)]
            : idxFromFuture;
        if (idx === undefined || idx < 0 || idx >= s.queue.length) return s;
        if (idx === s.currentIndex) return s;
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          playHistory: pushHistory(s.playHistory, s.currentIndex),
          playFuture: future,
          shuffleRemaining: idxFromFuture === undefined ? removeQueueIndex(shufflePool, idx) : s.shuffleRemaining,
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
  setVolume: (v) => {
    const volume = Math.max(0, Math.min(1, v));
    writeStoredVolume(volume);
    set({ volume });
  },
  toggleMute: () =>
    set((s) => {
      const isMuted = !s.isMuted;
      writeStoredMuted(isMuted);
      return { isMuted };
    }),
  toggleShuffle: () =>
    set((s) => {
      const shuffle = !s.shuffle;
      writeStoredShuffle(shuffle);
      return {
        shuffle,
        playHistory: [],
        playFuture: [],
        shuffleRemaining: shuffle ? createShuffleRemaining(s.queue.length, s.currentIndex) : [],
      };
    }),
  cycleRepeatMode: () =>
    set((s) => {
      const repeatMode = s.repeatMode === "off" ? "all" : s.repeatMode === "all" ? "one" : "off";
      writeStoredRepeatMode(repeatMode);
      return { repeatMode };
    }),
  setCrossfadeEnabled: (enabled) => {
    try { if (typeof window !== "undefined") localStorage.setItem(CROSSFADE_ENABLED_STORAGE_KEY, enabled ? "1" : "0"); } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try { if (typeof window !== "undefined") localStorage.setItem(CROSSFADE_SECONDS_STORAGE_KEY, String(clamped)); } catch {}
    set({ crossfadeSeconds: clamped });
  },
  setPlaybackRate: (rate) => {
    const clamped = Number.isFinite(rate) ? Math.max(0.5, Math.min(3, rate)) : 1;
    try { if (typeof window !== "undefined") localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped)); } catch {}
    set({ playbackRate: clamped });
  },
  startSleepTimer: (minutes) =>
    set({ sleepTimerEndsAt: Date.now() + minutes * 60_000, sleepAtEndOfTrack: false }),
  setSleepAtEndOfTrack: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: true }),
  cancelSleepTimer: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: false }),
}));
