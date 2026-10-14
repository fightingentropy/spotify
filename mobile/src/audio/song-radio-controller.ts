import { catalogSongKey } from "@/lib/catalog-reconciliation";
import { getIsOnline, subscribeOnline } from "@/lib/connectivity";
import { fetchRecommendations, recommendationToPlayerSong } from "@/lib/smart-shuffle";
import { getBlockedIds, getBlockedKeys } from "@/store/smart-shuffle-blocklist";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

type RadioRequest = Parameters<typeof fetchRecommendations>[0];
type LoadRecommendations = (input: RadioRequest, signal: AbortSignal) => Promise<PlayerSong[]>;

async function loadRecommendations(input: RadioRequest, signal: AbortSignal): Promise<PlayerSong[]> {
  return (await fetchRecommendations(input, signal)).map(recommendationToPlayerSong);
}

// Search starts with one chosen song. Fetch its neighbours immediately, then
// replenish near the end of the queue; staging and playback stay in the engines.
// queueToken scopes requests to a listening session, including account changes.
export function startSongRadioController(load: LoadRecommendations = loadRecommendations): () => void {
  let stopped = false;
  let scheduled = false;
  let active: { token: number; controller: AbortController } | null = null;
  let lastAttempt = "";

  function evaluate() {
    if (stopped) return;
    const state = usePlayerStore.getState();
    const radio = state.songRadio;
    const online = getIsOnline();
    if (active && (active.token !== radio?.token || !online)) {
      active.controller.abort();
      active = null;
      lastAttempt = "";
      if (radio?.status === "loading") state.setSongRadioStatus(radio.token, "idle");
    }
    if (!radio || !online) return;
    const upcoming = getUpcomingPlaybackIndices(state.queue.length, state.currentIndex, state.queue.length, state);
    // A manual addition while waiting for the service should play immediately.
    if (radio.waiting && upcoming.length) {
      state.next();
      return;
    }
    if ((!state.isPlaying && !radio.waiting && radio.status !== "idle") || active || upcoming.length >= 3) return;
    const current = state.currentSong;
    const attempt = `${radio.token}:${current ? catalogSongKey(current) : ""}`;
    if (lastAttempt === attempt && radio.status !== "idle") return;
    lastAttempt = attempt;
    const request = { token: radio.token, controller: new AbortController() };
    active = request;
    state.setSongRadioStatus(radio.token, "loading");
    const excluded = [...radio.seen, ...state.queue];
    const seeds = [radio.seed];
    // Keep the original search as an anchor. Manual picks shouldn't change the
    // station's direction, but a later recommendation can broaden the next batch.
    if (current && state.recommendedIds.has(current.id) && catalogSongKey(current) !== catalogSongKey(radio.seed)) seeds.push(current);
    const blocked = getBlockedKeys().flatMap((key) => {
      const separator = key.indexOf("::");
      return separator < 0 ? [] : [{ title: key.slice(0, separator), artist: key.slice(separator + 2) }];
    });
    void load({
      contextKey: `mobile-song-radio:${catalogSongKey(radio.seed)}`,
      seeds: seeds.map(({ title, artist }) => ({ title, artist })),
      exclude: [...excluded.map(({ title, artist }) => ({ title, artist })), ...blocked],
      excludeIds: [...new Set([...excluded.flatMap((song) => [song.id, song.discoverTrackId ?? ""]), ...getBlockedIds()].filter(Boolean))],
      limit: 12,
    }, request.controller.signal).then((songs) => {
      if (!stopped && !request.controller.signal.aborted) usePlayerStore.getState().appendSongRadio(request.token, songs);
    }).catch(() => {
      if (!stopped && !request.controller.signal.aborted) usePlayerStore.getState().setSongRadioStatus(request.token, "unavailable");
    }).finally(() => {
      if (active === request) active = null;
      schedule();
    });
  }

  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; evaluate(); });
  }
  const unsubscribe = usePlayerStore.subscribe(schedule);
  const unsubscribeOnline = subscribeOnline(() => { lastAttempt = ""; schedule(); });
  schedule();
  return () => {
    stopped = true;
    active?.controller.abort();
    unsubscribe();
    unsubscribeOnline();
  };
}
