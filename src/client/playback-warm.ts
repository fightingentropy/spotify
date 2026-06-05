"use client";

import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { isOfflinePlaybackSong } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";
import { resolveOfflinePlaybackSong } from "@/client/offline";

const PLAYBACK_CACHE = "spotify-playback-v1";
const PLAYBACK_WARM_BYTES = 512 * 1024;
const PLAYBACK_WARM_TIMEOUT_MS = 4_000;
const PLAYBACK_WARM_DEDUPE_MS = 2 * 60 * 1_000;
const PLAYBACK_WARM_QUEUE_LIMIT = 12;
const PLAYBACK_PREFETCH_FORWARD_TRACKS = 3;
const PLAYBACK_NETWORK_BACKOFF_MS = 45_000;

let warmPlaybackPumpRunning = false;
const warmPlaybackQueue: string[] = [];
const warmPlaybackSeen = new Map<string, number>();
let playbackNetworkBackoffUntil = 0;

function now(): number {
  return Date.now();
}

function sameOriginCacheableUrl(value: string | null | undefined): boolean {
  if (!value || /^(blob:|data:)/i.test(value)) return false;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin;
  } catch {
    return false;
  }
}

function resolveUrl(value: string): string {
  return new URL(value, location.origin).toString();
}

export function isPlaybackNetworkTemporarilyPoor(): boolean {
  return now() < playbackNetworkBackoffUntil;
}

export function notePlaybackNetworkFailure(): void {
  playbackNetworkBackoffUntil = Math.max(playbackNetworkBackoffUntil, now() + PLAYBACK_NETWORK_BACKOFF_MS);
}

export function notePlaybackNetworkSuccess(): void {
  playbackNetworkBackoffUntil = 0;
}

function shouldSkipSpeculativeMediaFetch(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.onLine === false) return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return !!(
    isPlaybackNetworkTemporarilyPoor() ||
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  );
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function warmPlaybackUrl(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!sameOriginCacheableUrl(url)) return;
  if (shouldSkipSpeculativeMediaFetch()) return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PLAYBACK_WARM_TIMEOUT_MS);
  try {
    const response = await fetch(resolveUrl(url), {
      credentials: "include",
      cache: "force-cache",
      headers: {
        Range: `bytes=0-${PLAYBACK_WARM_BYTES - 1}`,
      },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    notePlaybackNetworkSuccess();
  } catch {
    notePlaybackNetworkFailure();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function cacheSidecarUrl(url: string): Promise<void> {
  if (typeof caches === "undefined") return;
  if (!sameOriginCacheableUrl(url)) return;
  const absolute = resolveUrl(url);
  const cache = await caches.open(PLAYBACK_CACHE);
  if (await cache.match(absolute)) return;
  const response = await fetch(absolute, {
    credentials: "include",
    cache: "reload",
  });
  if (response.ok) await cache.put(absolute, response);
}

async function pumpWarmPlaybackQueue(): Promise<void> {
  if (warmPlaybackPumpRunning) return;
  warmPlaybackPumpRunning = true;
  try {
    for (;;) {
      const url = warmPlaybackQueue.shift();
      if (!url) break;
      await warmPlaybackUrl(url);
    }
  } finally {
    warmPlaybackPumpRunning = false;
  }
}

export function warmPlaybackSong(song: PlayerSong, priority = false): void {
  const playbackSong = resolveOfflinePlaybackSong(song);
  if (
    typeof window === "undefined" ||
    isBrowserLocalSong(playbackSong) ||
    isOfflinePlaybackSong(playbackSong) ||
    !sameOriginCacheableUrl(playbackSong.audioUrl)
  ) {
    return;
  }
  const url = resolveUrl(playbackSong.audioUrl);
  const seenAt = warmPlaybackSeen.get(url);
  const timestamp = now();
  if (seenAt && timestamp - seenAt < PLAYBACK_WARM_DEDUPE_MS) {
    const queuedIndex = warmPlaybackQueue.indexOf(url);
    if (priority && queuedIndex > 0) {
      warmPlaybackQueue.splice(queuedIndex, 1);
      warmPlaybackQueue.unshift(url);
    }
    return;
  }

  warmPlaybackSeen.set(url, timestamp);
  if (priority) {
    warmPlaybackQueue.unshift(url);
  } else {
    if (warmPlaybackQueue.length >= PLAYBACK_WARM_QUEUE_LIMIT) {
      warmPlaybackQueue.shift();
    }
    warmPlaybackQueue.push(url);
  }
  if (priority && warmPlaybackQueue.length > PLAYBACK_WARM_QUEUE_LIMIT) {
    warmPlaybackQueue.length = PLAYBACK_WARM_QUEUE_LIMIT;
  }
  void pumpWarmPlaybackQueue();
}

export async function prefetchUpcomingPlayback(queue: PlayerSong[], currentIndex: number): Promise<void> {
  if (shouldSkipSpeculativeMediaFetch()) return;
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return;
  const upcoming = queue
    .slice(currentIndex + 1, currentIndex + PLAYBACK_PREFETCH_FORWARD_TRACKS + 1)
    .map((song) => resolveOfflinePlaybackSong(song))
    .filter((song) => !isBrowserLocalSong(song));
  const audioUrls = uniqueStrings(
    upcoming.filter((song) => !isOfflinePlaybackSong(song)).map((song) => song.audioUrl),
  ).filter(sameOriginCacheableUrl);
  const sidecarUrls = uniqueStrings(
    upcoming.filter((song) => !isOfflinePlaybackSong(song)).flatMap((song) => [song.imageUrl, song.lyricsUrl]),
  ).filter(sameOriginCacheableUrl);

  for (const url of audioUrls) {
    await warmPlaybackUrl(url);
  }
  await Promise.all(sidecarUrls.map((url) => cacheSidecarUrl(url).catch(() => undefined)));
}
