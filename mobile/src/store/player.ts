import { create } from "zustand";
import { markPlaybackEngaged } from "@/audio/publish-gate";
import { getIsOnline } from "@/lib/connectivity";
import { songKind } from "@/lib/player-song";
import { storage } from "@/lib/storage";
import { useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

export type { PlayerSong } from "@/types/player";

// Ported from src/store/player.ts. Logic is verbatim; the only changes are the
// persistence layer (localStorage → synchronous MMKV `storage` shim) and the
// removal of the SSR `typeof window` guards. The queue-index-remap invariant,
// shuffle bookkeeping, and crossfade-commit contracts are preserved exactly —
// dropping any of them silently corrupts shuffle / back-forward navigation.

type PlayerState = {
  queue: PlayerSong[];
  currentIndex: number; // index in queue
  currentSong: PlayerSong | null;
  playHistory: number[];
  playFuture: number[];
  shuffleRemaining: number[];
  // Identifies the collection the current queue was started from (e.g. "liked",
  // `playlist:<id>`). Lets a collection's Play button know it owns the active
  // playback, so it can show Pause / resume instead of rebuilding the queue on
  // every press. null when the queue wasn't started from a tracked context.
  queueContextKey: string | null;
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
  // Swap a staged Discover track (matched by its old id) for the promoted,
  // now-in-library song after a "keep" action, so future loads use the library
  // copy instead of the .discover staging URL. Pure data swap — no reload.
  replaceStagedSong: (oldId: string, song: PlayerSong) => void;
  addToQueue: (song: PlayerSong) => void;
  playNext: (song: PlayerSong) => void;
  removeFromQueue: (index: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  // Advance to the nearest queue item satisfying `canPlay`, skipping over the
  // ones that can't play right now (e.g. not-downloaded while offline). Returns
  // false when nothing else in the queue is playable, so the caller can stop
  // instead of churning. Reuses advanceToIndex's shuffle/history bookkeeping.
  skipToPlayable: (canPlay: (song: PlayerSong) => boolean) => boolean;
  // Prune the live queue down to the songs satisfying `canPlay` (e.g. downloaded
  // while offline), so subsequent advances can't surface an unplayable track.
  // The currently-playing song keeps its exact identity when it survives, so the
  // engine does NOT reload it — only the rest of the queue is swapped. No-op when
  // every song already passes (nothing to prune) or none does (let the caller's
  // advance stop cleanly rather than emptying the queue). Returns true if pruned.
  retainPlayable: (canPlay: (song: PlayerSong) => boolean) => boolean;
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
  // Tags the queue with the collection it came from (see queueContextKey).
  contextKey?: string;
};

type AdvanceToIndexOptions = {
  // True when the target index was peeked from playFuture (the redo stack), so
  // the commit should consume that entry rather than picking from the shuffle pool.
  fromFuture?: boolean;
  // Keep the current isPlaying value instead of forcing playback on. The
  // crossfade commit uses this so pausing mid-fade isn't undone when the queue
  // advances to the incoming track.
  preservePlayState?: boolean;
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
    return storage.getItem(SHUFFLE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredShuffle(enabled: boolean): void {
  try {
    storage.setItem(SHUFFLE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
}

function readStoredVolume(): number {
  try {
    const raw = storage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null) return 0.9;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.9;
  } catch {
    return 0.9;
  }
}

function writeStoredVolume(value: number): void {
  try {
    storage.setItem(VOLUME_STORAGE_KEY, String(value));
  } catch {}
}

function readStoredMuted(): boolean {
  try {
    return storage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStoredMuted(muted: boolean): void {
  try {
    storage.setItem(MUTED_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

function readStoredRepeatMode(): PlayerState["repeatMode"] {
  try {
    const raw = storage.getItem(REPEAT_MODE_STORAGE_KEY);
    return raw === "one" || raw === "all" || raw === "off" ? raw : "off";
  } catch {
    return "off";
  }
}

function writeStoredRepeatMode(mode: PlayerState["repeatMode"]): void {
  try {
    storage.setItem(REPEAT_MODE_STORAGE_KEY, mode);
  } catch {}
}

function readStoredCrossfadeEnabled(): boolean {
  try {
    const raw = storage.getItem(CROSSFADE_ENABLED_STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function readStoredCrossfadeSeconds(): number {
  try {
    const raw = storage.getItem(CROSSFADE_SECONDS_STORAGE_KEY);
    const value = Number(raw ?? 4);
    return Number.isFinite(value) ? Math.max(0, Math.min(12, value)) : 4;
  } catch {
    return 4;
  }
}

function readStoredPlaybackRate(): number {
  try {
    const raw = storage.getItem(PLAYBACK_RATE_STORAGE_KEY);
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

export type UpcomingPlaybackState = {
  shuffle: boolean;
  repeatMode: PlayerState["repeatMode"];
  playFuture: number[];
  shuffleRemaining: number[];
};

// The next `count` queue indices in *playback* order — the order next() would
// actually visit them, not array order. Used to prefetch/warm upcoming tracks so
// the warmer doesn't fetch the wrong songs under shuffle. Mirrors next() and the
// QueueSheet "up next" list: in shuffle, the redo stack (playFuture, top first)
// comes before the shuffle pool. Pool picks are random at play time, so warming
// the pool's leading entries is a best-effort hedge for the next fresh draw.
export function getUpcomingPlaybackIndices(
  queueLength: number,
  currentIndex: number,
  count: number,
  state: UpcomingPlaybackState,
): number[] {
  if (queueLength <= 0 || count <= 0) return [];
  const safeCurrent = clampQueueIndex(queueLength, currentIndex);
  const result: number[] = [];
  const seen = new Set<number>([safeCurrent]);
  const push = (index: number | undefined): void => {
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= queueLength) return;
    if (seen.has(index)) return;
    seen.add(index);
    result.push(index);
  };

  if (state.shuffle) {
    if (queueLength <= 1) return [];
    // Deterministic redo stack first (top of playFuture is the next track).
    for (let i = state.playFuture.length - 1; i >= 0 && result.length < count; i -= 1) {
      push(state.playFuture[i]);
    }
    if (result.length < count) {
      const validRemaining = validShuffleRemaining(queueLength, safeCurrent, state.shuffleRemaining);
      // Mirror next()'s repeat-off stop: once the pool is spent and we're not
      // repeating, there's no further track to warm.
      const pool =
        validRemaining.length > 0
          ? validRemaining
          : state.repeatMode === "all"
            ? createShuffleRemaining(queueLength, safeCurrent)
            : [];
      for (const index of pool) {
        if (result.length >= count) break;
        push(index);
      }
    }
    return result;
  }

  // Linear: walk forward, wrapping to the start once if repeat "all".
  for (let index = safeCurrent + 1; index < queueLength && result.length < count; index += 1) {
    push(index);
  }
  if (state.repeatMode === "all") {
    for (let index = 0; index <= safeCurrent && result.length < count; index += 1) {
      push(index);
    }
  }
  return result;
}

export function sleepTimerRemainingMinutes(endsAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}

// Offline, collapse the live queue to downloaded songs before an advance so
// next()/previous() can only land on a track we can actually play — never a
// flash through an un-streamable one. Online (the default) leaves the queue
// untouched, and a fully-downloaded or fully-undownloaded queue is a no-op.
// Hoisted so next()/previous() (defined in the store factory below) can call it.
function pruneQueueWhenOffline(): void {
  if (getIsOnline()) return;
  const isDownloaded = useOfflineStore.getState().isDownloaded;
  usePlayerStore.getState().retainPlayable((song) => isDownloaded(song.id));
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  playHistory: [],
  playFuture: [],
  shuffleRemaining: [],
  queueContextKey: null,
  isPlaying: false,
  volume: readStoredVolume(),
  isMuted: readStoredMuted(),
  shuffle: readStoredShuffle(),
  repeatMode: readStoredRepeatMode(),
  crossfadeEnabled: readStoredCrossfadeEnabled(),
  crossfadeSeconds: readStoredCrossfadeSeconds(),
  playbackRate: readStoredPlaybackRate(),
  sleepTimerEndsAt: null,
  sleepAtEndOfTrack: false,
  setQueue: (songs, startIndex, options) => {
    // Keep a queue to a single kind so music never auto-advances into a podcast
    // (or radio) item. The track you explicitly start — songs[startIndex], read
    // before any shuffle randomization — anchors the kind; mixed lists like
    // "Recently played" (which can include podcast episodes you've listened to)
    // are filtered down to that kind. See songKind().
    const anchorIndex = clampQueueIndex(songs.length, startIndex);
    const anchor = anchorIndex >= 0 ? songs[anchorIndex] ?? null : null;
    const queue = anchor ? songs.filter((item) => songKind(item) === songKind(anchor)) : songs;
    const start = anchor
      ? options?.respectShuffle === true && get().shuffle
        ? resolveQueueStartIndex(queue.length, 0, true)
        : Math.max(0, queue.findIndex((item) => item.id === anchor.id))
      : -1;
    const currentSong = start >= 0 ? queue[start] ?? null : null;
    set(() => ({
      queue,
      currentIndex: start,
      currentSong,
      playHistory: [],
      playFuture: [],
      shuffleRemaining: get().shuffle ? createShuffleRemaining(queue.length, start) : [],
      queueContextKey: currentSong != null ? (options?.contextKey ?? null) : null,
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
      queueContextKey: null,
    }),
  advanceToIndex: (index, options) =>
    set((s) => {
      if (index < 0 || index >= s.queue.length || index === s.currentIndex) return s;
      const nextPlaying = options?.preservePlayState ? s.isPlaying : true;
      if (!s.shuffle) {
        return {
          ...s,
          currentIndex: index,
          currentSong: s.queue[index],
          isPlaying: nextPlaying,
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
        isPlaying: nextPlaying,
      };
    }),
  skipToPlayable: (canPlay) => {
    const s = get();
    const n = s.queue.length;
    if (n === 0) return false;
    let target: number | undefined;
    if (s.shuffle) {
      // Prefer not-yet-played picks so shuffle doesn't repeat itself; fall back
      // to any playable index other than the current (failed) one.
      const fresh = validShuffleRemaining(n, s.currentIndex, s.shuffleRemaining).filter(
        (i) => i !== s.currentIndex && canPlay(s.queue[i]),
      );
      const pool =
        fresh.length > 0
          ? fresh
          : s.queue.reduce<number[]>((acc, song, i) => {
              if (i !== s.currentIndex && canPlay(song)) acc.push(i);
              return acc;
            }, []);
      if (pool.length > 0) target = pool[Math.floor(Math.random() * pool.length)];
    } else {
      for (let step = 1; step < n; step++) {
        const i = (s.currentIndex + step) % n;
        if (canPlay(s.queue[i])) {
          target = i;
          break;
        }
      }
    }
    if (target === undefined) return false;
    get().advanceToIndex(target);
    return true;
  },
  retainPlayable: (canPlay) => {
    let pruned = false;
    set((s) => {
      const n = s.queue.length;
      if (n === 0) return s;
      const kept: number[] = [];
      for (let i = 0; i < n; i += 1) {
        if (canPlay(s.queue[i])) kept.push(i);
      }
      // Nothing to do if every song is already playable, or none is (emptying a
      // live queue would be worse than letting the engine's reactive guard stop).
      if (kept.length === n || kept.length === 0) return s;

      const oldToNew = new Map<number, number>();
      kept.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));
      const queue = kept.map((i) => s.queue[i]);

      // Map the current song forward. If it survived the prune, keep the exact
      // object so currentSong identity is unchanged → the engine does NOT reload
      // it and the track keeps playing while the rest of the queue is swapped to
      // downloads. If the current song itself can't play, move to the nearest
      // kept song at/after it (wrapping) — a single deliberate hop to a playable
      // track, never a flash through an unplayable one.
      let currentIndex: number;
      let currentSong: PlayerSong | null;
      const mappedCurrent = oldToNew.get(s.currentIndex);
      if (mappedCurrent !== undefined) {
        currentIndex = mappedCurrent;
        currentSong = s.currentSong;
      } else {
        const forward = kept.find((i) => i > s.currentIndex);
        currentIndex = oldToNew.get(forward ?? kept[0]) as number;
        currentSong = queue[currentIndex];
      }

      const remap = (indices: number[]): number[] =>
        indices.reduce<number[]>((acc, i) => {
          const mapped = oldToNew.get(i);
          if (mapped !== undefined) acc.push(mapped);
          return acc;
        }, []);

      pruned = true;
      return {
        ...s,
        queue,
        currentIndex,
        currentSong,
        // Keep back/forward navigation working across the smaller queue; rebuild
        // the shuffle pool fresh so shuffle keeps cycling the downloaded subset
        // instead of risking an empty pool that would stop playback early.
        playHistory: remap(s.playHistory),
        playFuture: remap(s.playFuture),
        shuffleRemaining: s.shuffle ? createShuffleRemaining(queue.length, currentIndex) : [],
      };
    });
    return pruned;
  },
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
  replaceStagedSong: (oldId, song) =>
    set((s) => {
      const matchIndex = s.queue.findIndex((item) => item.id === oldId);
      if (matchIndex < 0) {
        return s.currentSong?.id === oldId ? { currentSong: song } : s;
      }
      const queue = s.queue.slice();
      queue[matchIndex] = song;
      return {
        queue,
        currentSong: s.currentSong?.id === oldId ? song : s.currentSong,
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
  play: () => {
    markPlaybackEngaged();
    set({ isPlaying: true });
  },
  pause: () => set({ isPlaying: false }),
  toggle: () => {
    markPlaybackEngaged();
    set((s) => ({ isPlaying: !s.isPlaying }));
  },
  next: () => {
    markPlaybackEngaged();
    pruneQueueWhenOffline();
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
        // repeat one handled in the audio controller; here stop at end for off
        return { ...s, isPlaying: false };
      }
      const idx = s.currentIndex + 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    });
  },
  previous: () => {
    markPlaybackEngaged();
    pruneQueueWhenOffline();
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
    });
  },
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
    try {
      storage.setItem(CROSSFADE_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try {
      storage.setItem(CROSSFADE_SECONDS_STORAGE_KEY, String(clamped));
    } catch {}
    set({ crossfadeSeconds: clamped });
  },
  setPlaybackRate: (rate) => {
    const clamped = Number.isFinite(rate) ? Math.max(0.5, Math.min(3, rate)) : 1;
    try {
      storage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped));
    } catch {}
    set({ playbackRate: clamped });
  },
  startSleepTimer: (minutes) =>
    set({ sleepTimerEndsAt: Date.now() + minutes * 60_000, sleepAtEndOfTrack: false }),
  setSleepAtEndOfTrack: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: true }),
  cancelSleepTimer: () => set({ sleepTimerEndsAt: null, sleepAtEndOfTrack: false }),
}));
