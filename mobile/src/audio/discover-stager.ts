import { isUnstagedDiscoverSong, stageDiscoverSong } from "@/lib/discover-queue";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Just-in-time staging for Discover queues. Tapping a Discover track queues the
// whole row; the not-yet-staged entries enter as placeholders (empty audioUrl)
// and this materializes them on demand — the current placeholder so it can play,
// plus a one-ahead prefetch so linear advances stay gapless. Both audio engines
// idle on a placeholder (never load an empty URL) and reload once
// replaceStagedSong swaps in the real source.
//
// Ported from the web DiscoverQueueStager component; the React lifecycle became a
// plain store subscription that runs engine-side. Two things make the module-global
// bookkeeping race-safe (the web per-component refs hid these):
//   1. A request's role (current vs prefetch) is decided at RESOLUTION time from
//      the LIVE store, not captured at call time — a one-ahead prefetch that catches
//      up to become the current track before it resolves is then driven through the
//      same retry/skip path as any current track, so the queue can never hang on it.
//   2. The transient failure state is reset on the store's queueToken (bumped only
//      by setQueue/setSong), so a genuinely new queue — including re-tapping the same
//      row — retries previously-failed tracks, while an in-place replaceStagedSong
//      does not.

const MAX_CONSECUTIVE_FAILURES = 3;

// How many upcoming slots to warm ahead of the current track (linear playback).
// Two keeps transitions gapless even when a song is short or the user skips fast.
const PREFETCH_AHEAD = 2;
let started = false;
// Placeholder ids with a stage request in flight (dedupe). Keyed by id only; a
// stale resolution is harmless because the .then/.catch re-read the live current
// track, so they always act on whatever is actually playing that id now.
const inFlight = new Set<string>();
// Placeholders that failed a PREFETCH this queue — don't keep re-hitting the stager
// for a not-yet-current track. Never blocks a CURRENT-track attempt. Cleared on a
// new queueToken.
const prefetchFailed = new Set<string>();
// Consecutive failures while the CURRENT track couldn't be staged. Trips the
// breaker so a fully-dead queue stops cleanly; reset on a healthy current track and
// on a new queueToken.
let consecutiveCurrentFailures = 0;

function stage(song: PlayerSong, intent: "current" | "prefetch"): void {
  const id = song.id;
  if (inFlight.has(id)) return;
  // A current-track attempt is never suppressed by the prefetch blacklist — it must
  // always be retried (or skipped) so playback can't hang on a placeholder.
  if (intent === "prefetch" && prefetchFailed.has(id)) return;
  // The queue this request belongs to. A resolution that lands after the user has
  // started a different queue (token bumped) must not touch the new queue's
  // transient state — otherwise a slow prior-queue rejection could re-poison
  // prefetchFailed after the new-queue reset cleared it.
  const epoch = usePlayerStore.getState().queueToken;
  // Smart Shuffle recs AND YouTube Music mix tracks preview from YouTube (cheap,
  // resolver-independent); the curated Discover/Top-50 row stays lossless. Rec
  // membership lives in recommendedIds (the placeholder id is still current here,
  // before the staged-id swap); a mix track carries its own youtubeVideoId.
  const preview = usePlayerStore.getState().recommendedIds.has(id) || Boolean(song.youtubeVideoId);
  inFlight.add(id);
  void stageDiscoverSong(song, { preview })
    .then((real) => {
      const state = usePlayerStore.getState();
      const fresh = state.queueToken === epoch;
      if (fresh) prefetchFailed.delete(id);
      const wasCurrent = state.currentSong?.id === id;
      // Swap the placeholder for the real source in place; the engine subscription
      // loads/plays it, honoring the live isPlaying. Safe even when stale — it only
      // swaps a matching id that's actually in the live queue.
      state.replaceStagedSong(id, real);
      // A current track that just became playable means the dead-run is broken.
      if (fresh && wasCurrent) consecutiveCurrentFailures = 0;
    })
    .catch(() => {
      const state = usePlayerStore.getState();
      // Stale rejection from a superseded queue — drop it (finally still frees inFlight).
      if (state.queueToken !== epoch) return;
      // Role decided HERE, from live state — not the captured intent.
      if (state.currentSong?.id !== id) {
        prefetchFailed.add(id);
        return;
      }
      consecutiveCurrentFailures += 1;
      if (consecutiveCurrentFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveCurrentFailures = 0;
        state.pause(); // stop — don't churn a fully-dead queue forever
        return;
      }
      // Skip the dead current track so the queue keeps moving. Detect "next() can't
      // advance" by INDEX (a duplicate track id later in the row would make an id
      // check wrongly read a real advance as stuck); a genuine single-track queue
      // under repeat leaves currentIndex unchanged → pause instead of hanging.
      const beforeIndex = state.currentIndex;
      state.next();
      if (usePlayerStore.getState().currentIndex === beforeIndex) {
        consecutiveCurrentFailures = 0;
        usePlayerStore.getState().pause();
      }
    })
    .finally(() => {
      inFlight.delete(id);
    });
}

function evaluate(s: ReturnType<typeof usePlayerStore.getState>): void {
  // Only stage while actively playing. A paused placeholder waits for the user to
  // press play — and this stops the breaker's pause() from re-triggering evaluate
  // (via the isPlaying→false event) and re-arming the skip cascade. Pressing play
  // re-enters here and retries the current track.
  if (!s.isPlaying) return;

  const current = s.queue[s.currentIndex] ?? null;
  if (current && isUnstagedDiscoverSong(current)) {
    stage(current, "current");
  } else if (current) {
    // A real, playable current track means the queue is healthy — clear the breaker
    // (handles the case where the current track became playable via prefetch rather
    // than a current-attempt success).
    consecutiveCurrentFailures = 0;
  }

  // Prefetch the next few ahead (linear only — shuffle's next pick is random, so
  // warming a specific slot would usually be wrong). Staging while the current track
  // plays keeps transitions seamless even through short songs / quick skips; stage()
  // dedupes in-flight ids and blacklists failed prefetches, so a deeper window can't
  // double-fire or thrash.
  if (!s.shuffle) {
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const upcoming = s.queue[s.currentIndex + offset] ?? null;
      if (upcoming && isUnstagedDiscoverSong(upcoming)) stage(upcoming, "prefetch");
    }
  }
}

export function startDiscoverQueueStager(): void {
  if (started) return;
  started = true;
  let prev = usePlayerStore.getState();
  let prevToken = prev.queueToken;
  evaluate(prev);
  usePlayerStore.subscribe((state) => {
    if (state.queueToken !== prevToken) {
      // Brand-new queue (setQueue/setSong) — including a re-tap of the same row.
      // Reset per-queue failure state so previously-failed tracks are retried.
      // inFlight is intentionally NOT cleared: pending requests self-clean via
      // finally and re-check the live current track at resolution, so they stay
      // correct across the swap (and clearing it would only allow a duplicate).
      prevToken = state.queueToken;
      prefetchFailed.clear();
      consecutiveCurrentFailures = 0;
    }
    if (
      state.queue !== prev.queue ||
      state.currentIndex !== prev.currentIndex ||
      state.isPlaying !== prev.isPlaying ||
      state.shuffle !== prev.shuffle
    ) {
      evaluate(state);
    }
    prev = state;
  });
}
