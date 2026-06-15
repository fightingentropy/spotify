// Backend-agnostic cross-device resume + "now position" tracking, shared by both
// audio backends (engine-rntp on Android, engine-native on iOS). Extracted from
// the original engine.ts so the dispatcher can re-export publish/restore from one
// place and both backends write the same `lastPosition` / resume-seek state.

import {
  fetchServerPlaybackState,
  getPlaybackDeviceId,
  isPersistablePlayerSong,
  type PlaybackStateSnapshot,
  PLAYBACK_STATE_VERSION,
  readLocalPlaybackState,
  writeLocalPlaybackState,
  writeServerPlaybackState,
} from "@/lib/playback-state";
import { getOfflineAccountScope } from "@/store/offline";
import { usePlayerStore } from "@/store/player";

export const PLAYBACK_STATE_PUBLISH_INTERVAL_MS = 8000;

let lastPosition = 0;
let lastStatePublishMs = 0;
let pendingResumeSeek: { songId: string; time: number } | null = null;

export function setLastPosition(position: number): void {
  lastPosition = position;
}

export function getLastPosition(): number {
  return lastPosition;
}

export function setPendingResumeSeek(songId: string, time: number): void {
  pendingResumeSeek = { songId, time };
}

// Returns the pending resume position for `songId` (and consumes it), else null.
export function takePendingResumeSeek(songId: string): number | null {
  if (pendingResumeSeek && pendingResumeSeek.songId === songId) {
    const time = pendingResumeSeek.time;
    pendingResumeSeek = null;
    return time;
  }
  return null;
}

function buildSnapshot(): PlaybackStateSnapshot | null {
  const s = usePlayerStore.getState();
  const song = s.currentSong;
  if (!song || !isPersistablePlayerSong(song)) return null;
  const queue = s.queue.filter(isPersistablePlayerSong);
  const currentIndex = Math.max(0, queue.findIndex((item) => item.id === song.id));
  return {
    version: PLAYBACK_STATE_VERSION,
    accountScope: getOfflineAccountScope(),
    queue: queue.length ? queue : [song],
    currentIndex,
    song,
    currentTime: lastPosition,
    isPlaying: s.isPlaying,
    updatedAt: Date.now(),
    deviceId: getPlaybackDeviceId(),
  };
}

export async function publishPlaybackState(force: boolean): Promise<void> {
  if (!force && Date.now() - lastStatePublishMs < PLAYBACK_STATE_PUBLISH_INTERVAL_MS) return;
  lastStatePublishMs = Date.now();
  const snapshot = buildSnapshot();
  if (!snapshot) return;
  writeLocalPlaybackState(snapshot);
  try {
    await writeServerPlaybackState(snapshot);
  } catch {
    // offline — local snapshot is kept; a future publish will sync it.
  }
}

function applyPlaybackSnapshot(snapshot: PlaybackStateSnapshot): void {
  setPendingResumeSeek(snapshot.song.id, snapshot.currentTime);
  const store = usePlayerStore.getState();
  store.setQueue(snapshot.queue, snapshot.currentIndex);
  store.pause(); // never auto-play on cold launch
}

// Restore queue/index/position on launch. Does NOT auto-play. The local snapshot
// (synchronous MMKV) is applied IMMEDIATELY so the mini-player appears the
// instant this runs, instead of waiting on a server round-trip. The server is
// then reconciled in the background and only overrides if it's strictly newer
// (e.g. you were playing on another device since this device last published).
export async function restorePlaybackState(): Promise<void> {
  const scope = getOfflineAccountScope();
  const local = readLocalPlaybackState();
  const localUsable = local && local.accountScope === scope && local.song ? local : null;
  if (localUsable) applyPlaybackSnapshot(localUsable);

  try {
    const server = await fetchServerPlaybackState();
    if (server?.song && (!localUsable || server.updatedAt > localUsable.updatedAt)) {
      applyPlaybackSnapshot(server);
    }
  } catch {
    // offline / server error — the local snapshot already on screen stands.
  }
}
