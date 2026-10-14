import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mock } from "bun:test";
import type { PlayerSong } from "../../src/types/player";

// Only native I/O is stubbed. Queue edits, recommendations, selection, request
// lifecycle, normalization and blocklist logic all run their production code.
const memory = new Map<string, string>();
const downloaded = new Set<string>();
let online = true;
const listeners = new Set<(value: boolean) => void>();
mock.module("../../src/lib/storage", () => ({ storage: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
} }));
mock.module("../../src/lib/connectivity", () => ({
  getIsOnline: () => online,
  subscribeOnline: (listener: (value: boolean) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
}));
mock.module("../../src/store/offline", () => ({
  getOfflineAccountScope: () => "test",
  useOfflineStore: { getState: () => ({ isDownloaded: (id: string) => downloaded.has(id) }) },
}));
mock.module("../../src/lib/http", () => ({ apiFetch: () => { throw new Error("Unexpected network request"); }, apiFetchWithTimeout: () => { throw new Error("Unexpected network request"); } }));
mock.module("../../src/audio/engine", () => ({ seek: async () => {} }));

const { usePlayerStore: store, getUpcomingPlaybackIndices } = await import("../../src/store/player");
const { toggleSearchSong, playSongs } = await import("../../src/audio/actions");
const { startSongRadioController } = await import("../../src/audio/song-radio-controller");
const { addBlocked } = await import("../../src/store/smart-shuffle-blocklist");
const { recommendationToPlayerSong } = await import("../../src/lib/smart-shuffle");
const state = () => store.getState();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const song = (id: string, extra: Partial<PlayerSong> = {}): PlayerSong => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, audioUrl: `https://media.test/${id}`, imageUrl: "", ...extra });
const seed = song("seed", { title: "Babydoll", artist: "Dominic Fike", discoverTrackId: "seed-provider" });
const recs = [song("rec-a"), song("rec-b"), song("rec-c"), song("rec-d")];
const token = () => state().songRadio!.token;
const upcoming = () => getUpcomingPlaybackIndices(state().queue.length, state().currentIndex, state().queue.length, state()).map((index) => state().queue[index].id);
function connectivity(value: boolean) { online = value; for (const listener of listeners) listener(value); }
function reset() {
  memory.clear(); downloaded.clear(); online = true;
  store.setState({ shuffle: false, repeatMode: "off", smartShuffleEnabled: false });
  state().setQueue([], 0);
}
let count = 0;
async function scenario(name: string, run: () => void | Promise<void>) {
  reset();
  await run();
  count++;
  console.log(`PASS ${name}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

await scenario("search selects one song, toggles its staged identity, and leaves collection playback intact", () => {
  toggleSearchSong(seed);
  assert.deepEqual(state().queue.map((track) => track.id), [seed.id]);
  assert.equal(state().smartShuffleEnabled, false);
  const epoch = token();
  state().replaceStagedSong(seed.id, { ...seed, id: "staged-seed", preview: false });
  toggleSearchSong({ ...seed, preview: true });
  assert.equal(state().isPlaying, false);
  assert.equal(token(), epoch);
  playSongs([seed, ...recs], 0, { contextKey: "playlist:mine" });
  assert.equal(state().songRadio, null);
  assert.deepEqual(upcoming(), recs.map((track) => track.id));
  toggleSearchSong(song("podcast", { source: "podcast" }));
  assert.equal(state().songRadio, null);
});

await scenario("recommendations deduplicate recording metadata and provider IDs, stay temporary, and honor blocks", () => {
  toggleSearchSong(seed);
  addBlocked(recs[2]);
  const converted = recommendationToPlayerSong({ id: "provider-a", title: "New song", artist: "New artist", album: "", imageUrl: "", durationMs: 182000, spotifyUrl: "", staged: false });
  state().appendSongRadio(token(), [
    song("copy", { title: " BABYDOLL! ", artist: "Dominic Fike" }),
    song("copy2", { discoverTrackId: "seed-provider" }),
    recs[0], { ...recs[0], id: "copy3" }, recs[2], converted,
    song("radio", { source: "radio" }),
  ]);
  assert.deepEqual(upcoming(), ["rec-a", "discover:provider-a"]);
  assert.equal(state().queue[2].duration, 182);
  assert.equal(state().queue[2].audioUrl, "");
  assert.ok(state().queue.slice(1).every((track) => track.preview));
  state().replaceStagedSong("rec-a", { ...recs[0], id: "staged-rec-a" });
  assert.ok(state().recommendedIds.has("staged-rec-a"));
  state().removeFromQueue(2);
  state().appendSongRadio(token(), [converted]);
  assert.deepEqual(upcoming(), ["staged-rec-a"]);
});

for (const shuffle of [false, true]) await scenario(`manual FIFO and Play Next precede autoplay; shuffle=${shuffle}`, () => {
  store.setState({ shuffle });
  toggleSearchSong(seed);
  state().appendSongRadio(token(), recs);
  state().addToQueue(song("manual-one"));
  state().addToQueue(song("manual-two"));
  state().playNext(song("play-next"));
  assert.deepEqual(upcoming(), ["play-next", "manual-one", "manual-two", ...recs.map((track) => track.id)]);
  for (const id of ["play-next", "manual-one", "manual-two", "rec-a"]) {
    state().next(); assert.equal(state().currentSong?.id, id);
  }
  state().previous(); assert.equal(state().currentSong?.id, "manual-two");
  state().next(); assert.equal(state().currentSong?.id, "rec-a");
});

await scenario("repeat all waits for new music instead of recycling the search queue", () => {
  store.setState({ repeatMode: "all", shuffle: true });
  toggleSearchSong(seed);
  state().next();
  assert.equal(state().songRadio?.waiting, true);
  state().appendSongRadio(token(), [recs[0]]);
  assert.equal(state().currentSong?.id, "rec-a");
  state().next();
  assert.equal(state().isPlaying, false);
  assert.deepEqual(upcoming(), []);
});

await scenario("pause and sleep-stop intent survive late recommendations", () => {
  toggleSearchSong(seed);
  state().next();
  state().pause();
  state().appendSongRadio(token(), recs);
  assert.equal(state().currentSong?.id, seed.id);
  assert.equal(state().isPlaying, false);
  assert.equal(state().songRadio?.waiting, false);
});

await scenario("crossfade commits use the predicted queue order without resuming a paused player", () => {
  store.setState({ shuffle: true });
  toggleSearchSong(seed);
  state().appendSongRadio(token(), recs);
  state().playNext(song("manual"));
  const index = getUpcomingPlaybackIndices(state().queue.length, state().currentIndex, 1, state())[0];
  state().pause();
  state().advanceToIndex(index, { fromFuture: true, preservePlayState: true });
  assert.equal(state().currentSong?.id, "manual");
  assert.equal(state().isPlaying, false);
  assert.deepEqual(upcoming(), recs.map((track) => track.id));
});

await scenario("Smart Shuffle changes do not remove search recommendations", () => {
  toggleSearchSong(seed);
  state().appendSongRadio(token(), recs);
  state().setSmartShuffleEnabled(true);
  state().injectRecommendations([song("stray")]);
  state().setSmartShuffleEnabled(false);
  state().removeUnplayedRecommendations();
  assert.deepEqual(upcoming(), recs.map((track) => track.id));
});

await scenario("offline advances only to cached tracks, never wraps or silently starts on reconnect", () => {
  store.setState({ repeatMode: "all" });
  toggleSearchSong(seed);
  state().appendSongRadio(token(), recs);
  downloaded.add("rec-c");
  connectivity(false);
  state().next(); assert.equal(state().currentSong?.id, "rec-c");
  state().next(); assert.equal(state().isPlaying, false);
  assert.equal(state().songRadio?.waiting, false);
  connectivity(true); assert.equal(state().isPlaying, false);
});

await scenario("top-up sends the original anchor, recent recommendation, exclusions, and skips refill with a healthy buffer", async () => {
  const calls: Parameters<Parameters<typeof startSongRadioController>[0] & object>[0][] = [];
  const stop = startSongRadioController(async (input) => { calls.push(input); return recs; });
  try {
    toggleSearchSong(seed); await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].seeds, [{ title: seed.title, artist: seed.artist }]);
    assert.ok(calls[0].excludeIds?.includes("seed-provider"));
    state().next(); await tick(); assert.equal(calls.length, 1);
    state().next(); await tick(); assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].seeds, [{ title: seed.title, artist: seed.artist }, { title: recs[1].title, artist: recs[1].artist }]);
    assert.ok(calls[1].excludeIds?.includes("rec-d"));
  } finally { stop(); }
});

await scenario("late response starts autoplay only while EOF still wants to continue", async () => {
  const response = deferred<PlayerSong[]>();
  const stop = startSongRadioController(() => response.promise);
  try {
    toggleSearchSong(seed); await tick();
    state().next(); await tick();
    assert.equal(state().songRadio?.waiting, true);
    response.resolve(recs); await tick();
    assert.equal(state().currentSong?.id, "rec-a");
    assert.equal(state().isPlaying, true);
  } finally { stop(); }
});

await scenario("manual song added during a pending EOF request plays first", async () => {
  const response = deferred<PlayerSong[]>();
  const stop = startSongRadioController(() => response.promise);
  try {
    toggleSearchSong(seed); await tick(); state().next(); await tick();
    state().addToQueue(song("manual")); await tick();
    assert.equal(state().currentSong?.id, "manual");
    response.resolve(recs); await tick();
    assert.equal(state().currentSong?.id, "manual");
    assert.deepEqual(upcoming(), recs.map((track) => track.id));
  } finally { stop(); }
});

await scenario("switching search, collection, or account aborts stale requests", async () => {
  const pending: { response: ReturnType<typeof deferred<PlayerSong[]>>; signal: AbortSignal }[] = [];
  const stop = startSongRadioController((_input, signal) => {
    const response = deferred<PlayerSong[]>(); pending.push({ response, signal }); return response.promise;
  });
  try {
    toggleSearchSong(seed); await tick();
    toggleSearchSong(song("new-search")); await tick();
    assert.equal(pending[0].signal.aborted, true);
    pending[0].response.resolve(recs); await tick();
    assert.equal(state().queue.length, 1);
    playSongs([song("album")], 0); await tick();
    assert.equal(pending[1].signal.aborted, true);
    pending[1].response.resolve(recs); await tick();
    assert.equal(state().songRadio, null);
    toggleSearchSong(seed); await tick();
    state().setQueue([], 0); await tick();
    assert.equal(pending[2].signal.aborted, true);
    pending[2].response.resolve(recs); await tick();
    assert.equal(state().queue.length, 0);
  } finally { stop(); }
});

await scenario("service failures stop cleanly, do not loop, and allow explicit retry", async () => {
  let requests = 0;
  const stop = startSongRadioController(async () => { if (++requests === 1) throw new Error("unavailable"); return recs; });
  try {
    toggleSearchSong(seed); await tick();
    assert.equal(state().songRadio?.status, "unavailable");
    state().setVolume(0.5); await tick();
    state().next(); await tick();
    assert.equal(state().isPlaying, false);
    assert.equal(requests, 1);
    state().retrySongRadio(); await tick();
    assert.equal(requests, 2);
    assert.equal(state().songRadio?.status, "ready");
    assert.equal(state().isPlaying, false);
  } finally { stop(); }
});

await scenario("offline cancels fetching; reconnect refills without unpausing", async () => {
  const pending: { response: ReturnType<typeof deferred<PlayerSong[]>>; signal: AbortSignal }[] = [];
  const stop = startSongRadioController((_input, signal) => {
    const response = deferred<PlayerSong[]>(); pending.push({ response, signal }); return response.promise;
  });
  try {
    toggleSearchSong(seed); await tick();
    connectivity(false); await tick();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(state().songRadio?.status, "idle");
    state().pause(); connectivity(true); await tick();
    pending[1].response.resolve(recs); await tick();
    assert.equal(state().isPlaying, false);
    assert.equal(state().currentSong?.id, seed.id);
    pending[0].response.resolve([song("stale")]); await tick();
    assert.ok(!state().queue.some((track) => track.id === "stale"));
  } finally { stop(); }
});

console.log(`${count} song radio scenarios passed`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ passed: count }));
