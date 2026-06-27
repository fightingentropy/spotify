import { getIsOnline, subscribeOnline } from "@/lib/connectivity";
import { fetchRecommendations, recommendationToPlayerSong } from "@/lib/smart-shuffle";
import { getBlockedIds, getBlockedKeys } from "@/store/smart-shuffle-blocklist";
import { useLikesStore } from "@/store/likes";
import { MIN_RECS_AHEAD, MIN_SEEDS, RECS_FETCH_BATCH, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Smart Shuffle top-up loop. A store subscription (engine-side, mirroring the
// Discover stager) that keeps a buffer of recommended tracks queued ahead of the
// current track while the mode is on. The store owns the interleaving math
// (injectRecommendations) and rec-membership (recommendedIds); this module owns
// only the WHEN: it watches the queue/mode/online state, and when fewer than
// MIN_RECS_AHEAD recs sit ahead of currentIndex it fetches a fresh batch and
// hands it to injectRecommendations.
//
// Three things keep it race-safe (the queue can mutate under a slow fetch):
//   1. Every fetch captures the live queueToken epoch at call time; if the token
//      changed by the time it resolves (the user started a different queue), the
//      result is discarded and the pool reset — the new queue carries no stale recs.
//   2. A single in-flight flag prevents overlapping fetches (and the tight loop
//      where each store mutation from a splice would re-trigger another fetch).
//   3. Evaluation is debounced to a microtask so the burst of store updates a
//      single inject produces collapses into one re-check.
//
// Online-only: offline we stop fetching and prune the unplayed recs, but leave
// smartShuffleEnabled untouched so the mode auto-resumes on reconnect.

// Up to this many of the user's own queue songs are sampled as recommendation
// seeds per fetch. Over-sampling here just gives the recommender more to work
// with; the worker over-fetches and dedups regardless.
const MAX_SEEDS = 8;

let started = false;
// Recommended PlayerSongs fetched but not yet injected. Drained into the queue
// by injectRecommendations; what survives (deduped away or beyond the interval)
// stays buffered for the next top-up. Reset whenever the queue token changes.
let pool: PlayerSong[] = [];
let inFlight = false;
// The queueToken the pool was built under. A mismatch means the pool belongs to
// a superseded queue and must be dropped before reuse.
let poolToken = -1;
// Debounce handle: collapses the burst of store updates one inject emits (and
// rapid index advances) into a single evaluation.
let evalScheduled = false;

function resetPool(token: number): void {
  pool = [];
  poolToken = token;
}

// Count recommended songs queued strictly AHEAD of the current track — the
// buffer injectRecommendations has already placed. Drives the top-up decision.
function recsAhead(s: ReturnType<typeof usePlayerStore.getState>): number {
  let count = 0;
  for (let index = s.currentIndex + 1; index < s.queue.length; index += 1) {
    if (s.recommendedIds.has(s.queue[index].id)) count += 1;
  }
  return count;
}

function songKey(song: { title: string; artist: string }): string {
  return `${song.title.trim().toLowerCase()}::${song.artist.trim().toLowerCase()}`;
}

async function fetchAndInject(s: ReturnType<typeof usePlayerStore.getState>): Promise<void> {
  // The non-rec (user's own) songs in the live queue are both the seed pool and
  // part of the exclude set. A rec already in recommendedIds is neither.
  const ownSongs = s.queue.filter((song) => !s.recommendedIds.has(song.id));
  // Seeds: a fresh random sample of up to MAX_SEEDS own songs. Math.random is
  // available in the app runtime; the sample varies each fetch so successive
  // top-ups explore different neighbours.
  const shuffledOwn = ownSongs.slice();
  for (let i = shuffledOwn.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledOwn[i], shuffledOwn[j]] = [shuffledOwn[j], shuffledOwn[i]];
  }
  const seeds = shuffledOwn
    .slice(0, MAX_SEEDS)
    .map((song) => ({ title: song.title, artist: song.artist }));
  if (seeds.length < MIN_SEEDS) return; // too little to seed a recommendation

  // Exclude: every queue song's title::artist + the user's liked songs (the ids
  // we can resolve to title/artist via the live queue) + the blocklist keys.
  const likedIds = useLikesStore.getState().likedSongIds;
  const excludePairs = new Map<string, { title: string; artist: string }>();
  for (const song of s.queue) {
    excludePairs.set(songKey(song), { title: song.title, artist: song.artist });
  }
  for (const song of s.queue) {
    if (likedIds[song.id]) excludePairs.set(songKey(song), { title: song.title, artist: song.artist });
  }
  const blockedKeys = getBlockedKeys();
  // Blocklist keys are already normalized title::artist strings; the worker
  // dedups by the same normalized key, so passing them as exclude pairs (split
  // back into title/artist) keeps them out of the results.
  for (const key of blockedKeys) {
    const sep = key.indexOf("::");
    if (sep < 0) continue;
    const title = key.slice(0, sep);
    const artist = key.slice(sep + 2);
    excludePairs.set(key, { title, artist });
  }
  const exclude = [...excludePairs.values()];

  const excludeIds = [
    ...s.queue.map((song) => song.id),
    ...Object.keys(likedIds),
    ...getBlockedIds(),
  ];

  const epoch = s.queueToken;
  const contextKey = s.queueContextKey ?? undefined;
  inFlight = true;
  try {
    const tracks = await fetchRecommendations({
      contextKey,
      seeds,
      exclude,
      excludeIds,
      limit: RECS_FETCH_BATCH,
    });
    const live = usePlayerStore.getState();
    // The queue moved on while we fetched — drop the result and clear any pool
    // that belonged to the superseded queue.
    if (live.queueToken !== epoch) {
      resetPool(live.queueToken);
      return;
    }
    if (poolToken !== epoch) resetPool(epoch);
    // Drop recs already recommended or already present in the queue, then buffer
    // the rest; injectRecommendations also dedupes, but pruning here keeps the
    // pool from growing with no-ops.
    const presentIds = new Set(live.queue.map((song) => song.id));
    for (const track of tracks) {
      const rec = recommendationToPlayerSong(track);
      if (live.recommendedIds.has(rec.id) || presentIds.has(rec.id)) continue;
      if (pool.some((existing) => existing.id === rec.id)) continue;
      pool.push(rec);
    }
    if (pool.length > 0) {
      live.injectRecommendations(pool);
      // injectRecommendations consumes from the front and stops after placing
      // what the interval allows; whatever it couldn't place is dropped here so
      // the next top-up fetches fresh rather than re-offering stale picks.
      pool = [];
    }
  } catch {
    // A failed fetch degrades to "no recs this round" — never throws into the
    // subscription. The next store edge re-arms evaluation.
  } finally {
    inFlight = false;
  }
}

function evaluate(): void {
  const s = usePlayerStore.getState();
  // Reset the pool the instant the queue changes (or the mode flips off), so a
  // pending result can never leak into a new queue and a disabled mode doesn't
  // sit on a stale buffer.
  if (s.queueToken !== poolToken) resetPool(s.queueToken);
  if (!s.smartShuffleEnabled) {
    pool = [];
    return;
  }
  if (!getIsOnline()) return; // online-only; offline path prunes via subscribeOnline
  if (s.queueContextKey == null || s.queue.length === 0) return;
  if (inFlight) return;
  if (recsAhead(s) >= MIN_RECS_AHEAD) return;
  void fetchAndInject(s);
}

// Coalesce the burst of store updates a single inject (or a rapid sequence of
// advances) produces into one evaluation per tick.
function scheduleEvaluate(): void {
  if (evalScheduled) return;
  evalScheduled = true;
  queueMicrotask(() => {
    evalScheduled = false;
    evaluate();
  });
}

export function startSmartShuffleController(): void {
  if (started) return;
  started = true;
  let prev = usePlayerStore.getState();
  poolToken = prev.queueToken;
  scheduleEvaluate();
  usePlayerStore.subscribe((state) => {
    if (
      state.queue !== prev.queue ||
      state.currentIndex !== prev.currentIndex ||
      state.smartShuffleEnabled !== prev.smartShuffleEnabled ||
      state.queueToken !== prev.queueToken
    ) {
      scheduleEvaluate();
    }
    prev = state;
  });
  subscribeOnline((online) => {
    if (online) {
      // Reconnected: re-arm and top up. smartShuffleEnabled was left untouched
      // while offline, so the mode resumes on its own.
      scheduleEvaluate();
    } else {
      // Dropped: stop fetching and prune the unplayed recs so the user doesn't
      // stall on an un-streamable placeholder. The mode stays on for resume.
      pool = [];
      usePlayerStore.getState().removeUnplayedRecommendations();
    }
  });
}
