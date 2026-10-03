"use client";

import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { artworkVariantUrl } from "@/lib/artwork-url";
import type { PlayerSong } from "@/types/player";
import { getUpcomingPlaybackIndices, type UpcomingPlaybackState } from "@/store/player";

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

function sweepStalePlaybackSeen(timestamp: number): void {
  for (const [seenUrl, seenAt] of warmPlaybackSeen) {
    if (timestamp - seenAt >= PLAYBACK_WARM_DEDUPE_MS) warmPlaybackSeen.delete(seenUrl);
  }
}

async function warmPlaybackUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!sameOriginCacheableUrl(url)) return false;
  if (signal?.aborted || shouldSkipSpeculativeMediaFetch()) return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
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
    return response.ok;
  } catch {
    // Pausing or changing the queue cancels speculation; it is not evidence of
    // a poor connection and must not suppress a subsequent explicit play.
    if (!signal?.aborted) notePlaybackNetworkFailure();
    return false;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

async function cacheSidecarUrl(url: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || shouldSkipSpeculativeMediaFetch()) return;
  if (!sameOriginCacheableUrl(url)) return;
  // The app no longer has a service worker that reads CacheStorage. Warming the
  // normal HTTP cache lets <img> and lyrics fetches reuse these exact URLs.
  const response = await fetch(resolveUrl(url), {
    credentials: "include",
    cache: "force-cache",
    signal,
  });
  if (response.ok) await response.arrayBuffer();
  else await response.body?.cancel();
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
  if (
    typeof window === "undefined" ||
    isBrowserLocalSong(song) ||
    !sameOriginCacheableUrl(song.audioUrl)
  ) {
    return;
  }
  const url = resolveUrl(song.audioUrl);
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

  sweepStalePlaybackSeen(timestamp);
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

export async function prefetchUpcomingPlayback(
  queue: PlayerSong[],
  currentIndex: number,
  // Playback-order state, so shuffle warms the songs that will actually play next
  // (redo stack + shuffle pool) instead of the linear array neighbors. Defaults to
  // linear order for callers that don't track shuffle.
  state?: UpcomingPlaybackState,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || shouldSkipSpeculativeMediaFetch()) return;
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return;
  const upcoming = getUpcomingPlaybackIndices(
    queue.length,
    currentIndex,
    PLAYBACK_PREFETCH_FORWARD_TRACKS,
    state ?? { shuffle: false, repeatMode: "off", playFuture: [], shuffleRemaining: [] },
  )
    .map((index) => queue[index])
    .filter((song): song is PlayerSong => song != null)
    .filter((song) => !isBrowserLocalSong(song));
  const audioUrls = uniqueStrings(
    upcoming.map((song) => song.audioUrl),
  ).filter(sameOriginCacheableUrl);
  const sidecarUrls = uniqueStrings(
    // Match the compact player/queue artwork, including high-density screens.
    // The expanded player can request its larger responsive variant on demand.
    upcoming.flatMap((song) => [artworkVariantUrl(song.imageUrl, 128) ?? song.imageUrl, song.lyricsUrl]),
  ).filter(sameOriginCacheableUrl);

  for (const url of audioUrls) {
    if (signal?.aborted || shouldSkipSpeculativeMediaFetch()) return;
    // Route prefetch through the same dedupe set as warmPlaybackSong so a URL
    // already warmed (or warmed recently) isn't refetched on every queue-identity
    // change.
    const resolved = resolveUrl(url);
    const seenAt = warmPlaybackSeen.get(resolved);
    const timestamp = now();
    if (seenAt && timestamp - seenAt < PLAYBACK_WARM_DEDUPE_MS) continue;
    sweepStalePlaybackSeen(timestamp);
    // Mark seen up front to dedupe concurrent passes, but un-mark on failure so a
    // warm that cached nothing isn't suppressed for the full dedupe window.
    warmPlaybackSeen.set(resolved, timestamp);
    const warmed = await warmPlaybackUrl(url, signal);
    if (!warmed) warmPlaybackSeen.delete(resolved);
  }
  await Promise.all(sidecarUrls.map((url) => cacheSidecarUrl(url, signal).catch(() => undefined)));
}
