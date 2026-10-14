import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import { recommendationKey } from "@/lib/recommendations";
import type { DiscoverStagedTrack } from "@/worker/discover";
import type { PlayerSong } from "@/types/player";

type RadioRequest = {
  contextKey: string;
  seeds: { title: string; artist: string }[];
  exclude: { title: string; artist: string }[];
  excludeIds: string[];
  limit: number;
};
type LoadRecommendations = (input: RadioRequest, signal: AbortSignal) => Promise<PlayerSong[]>;

async function loadRecommendations(input: RadioRequest, signal: AbortSignal): Promise<PlayerSong[]> {
  const response = await fetch("/api/smart-shuffle/recommend", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  if (!response.ok) throw new Error("Related music is temporarily unavailable");
  const payload = await response.json() as { tracks?: DiscoverStagedTrack[] };
  return (payload.tracks ?? []).map((track) => ({
    id: track.audioId && track.audioUrl ? track.audioId : `discover:${track.id}`,
    title: track.title, artist: track.artist, album: track.album,
    imageUrl: track.imageUrl, audioUrl: track.audioUrl ?? "",
    duration: track.durationMs ? track.durationMs / 1000 : undefined,
    discoverTrackId: track.id, source: "server", staged: track.staged,
    // Autoplay uses the same temporary preview cache as search. Listening must
    // never save unsolicited tracks into the permanent library.
    preview: true, recommended: true,
  }));
}

// One session-scoped subscription, mounted beside the audio engine. Fetch early
// and top up with three tracks left; playback and staging remain in the existing
// engine. A different search/account/collection cancels the previous request.
export function startSongRadioController(load: LoadRecommendations = loadRecommendations): () => void {
  let stopped = false;
  let scheduled = false;
  let active: { token: number; controller: AbortController } | null = null;
  let lastAttempt = "";

  function evaluate() {
    if (stopped) return;
    const state = usePlayerStore.getState();
    const radio = state.songRadio;
    if (active && active.token !== radio?.token) {
      active.controller.abort();
      active = null;
    }
    if (!radio) return;
    const upcoming = getUpcomingPlaybackIndices(state.queue.length, state.currentIndex, state.queue.length, state);
    // A manual addition made while we're waiting for recommendations wins too.
    if (radio.waiting && upcoming.length) {
      state.next();
      return;
    }
    if ((!state.isPlaying && !radio.waiting && radio.status !== "idle") || active || upcoming.length >= 3) return;
    const current = state.currentSong;
    const attempt = `${radio.token}:${current ? recommendationKey(current) : ""}`;
    if (lastAttempt === attempt && radio.status !== "idle") return;
    lastAttempt = attempt;
    const request = { token: radio.token, controller: new AbortController() };
    active = request;
    state.setSongRadioStatus(radio.token, "loading");
    const excluded = [...radio.seen, ...state.queue];
    const seeds = [radio.seed];
    // Keep the original search as an anchor, while allowing later batches to
    // explore neighbours of the last recommendation (not an unrelated manual pick).
    if (current?.recommended && recommendationKey(current) !== recommendationKey(radio.seed)) seeds.push(current);
    void load({
      contextKey: `web-song-radio:${recommendationKey(radio.seed)}`,
      seeds: seeds.map(({ title, artist }) => ({ title, artist })),
      exclude: excluded.map(({ title, artist }) => ({ title, artist })),
      excludeIds: [...new Set(excluded.flatMap((song) => [song.id, song.discoverTrackId ?? ""]).filter(Boolean))],
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
  function reconnect() { lastAttempt = ""; schedule(); }
  const unsubscribe = usePlayerStore.subscribe(schedule);
  if (typeof window !== "undefined") window.addEventListener("online", reconnect);
  schedule();
  return () => {
    stopped = true;
    active?.controller.abort();
    unsubscribe();
    if (typeof window !== "undefined") window.removeEventListener("online", reconnect);
  };
}
