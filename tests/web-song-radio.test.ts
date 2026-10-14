import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startSongRadioController } from "../src/client/song-radio";
import { getUpcomingPlaybackIndices, usePlayerStore } from "../src/store/player";
import type { PlayerSong } from "../src/types/player";

const player = () => usePlayerStore.getState();
const song = (id: string): PlayerSong => ({
  id, title: `Song ${id}`, artist: `Artist ${id}`, audioUrl: `/${id}.mp3`, imageUrl: `/${id}.jpg`,
});
const ids = () => player().queue.map((item) => item.id);
const upcoming = () => {
  const s = player();
  return getUpcomingPlaybackIndices(s.queue.length, s.currentIndex, s.queue.length, s).map((index) => s.queue[index].id);
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let stop: (() => void) | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  player().setQueue([], 0);
  usePlayerStore.setState({ shuffle: false, repeatMode: "off", sleepAtEndOfTrack: false, sleepTimerEndsAt: null });
});
afterEach(() => {
  stop?.(); stop = undefined;
  player().setQueue([], 0);
  globalThis.fetch = originalFetch;
});

function pendingController() {
  const requests: {
    input: Parameters<NonNullable<Parameters<typeof startSongRadioController>[0]>>[0];
    signal: AbortSignal;
    resolve: (songs: PlayerSong[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  stop = startSongRadioController((input, signal) => new Promise((resolve, reject) => {
    requests.push({ input, signal, resolve, reject });
  }));
  return requests;
}

describe("web search autoplay", () => {
  test("starts only the selected track, fetches related music, and refills before the queue runs out", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed"));
    expect(ids()).toEqual(["seed"]);
    expect(player().isPlaying).toBe(true);
    await tick();
    expect(requests[0].input.seeds).toEqual([{ title: "Song seed", artist: "Artist seed" }]);
    requests[0].resolve([song("a"), song("b"), song("c"), song("d")]);
    await tick();
    expect(upcoming()).toEqual(["a", "b", "c", "d"]);
    expect(requests).toHaveLength(1);
    player().next(); player().next();
    await tick();
    expect(player().currentSong?.id).toBe("b");
    expect(requests).toHaveLength(2);
    expect(requests[1].input.seeds.map((s) => s.title)).toEqual(["Song seed", "Song b"]);
    expect(requests[1].input.excludeIds).toContain("a");
    requests[1].resolve([song("a"), song("e"), song("f")]);
    await tick();
    expect(upcoming()).toEqual(["c", "d", "e", "f"]);
  });

  for (const shuffle of [false, true]) test(`manual queue additions and play-next take priority (shuffle=${shuffle})`, () => {
    usePlayerStore.setState({ shuffle });
    player().startSongRadio(song("seed"));
    player().appendSongRadio(player().songRadio!.token, [song("a"), song("b"), song("c")]);
    player().addToQueue(song("manual1"));
    player().addToQueue(song("manual2"));
    player().playNext(song("first"));
    expect(upcoming()).toEqual(["first", "manual1", "manual2", "a", "b", "c"]);
    for (const expected of ["first", "manual1", "manual2", "a"]) {
      player().next();
      expect(player().currentSong?.id).toBe(expected);
    }
    player().previous();
    expect(player().currentSong?.id).toBe("manual2");
    player().next();
    expect(player().currentSong?.id).toBe("a");
  });

  test("a late result continues an exhausted queue, without repeating the seed", async () => {
    const requests = pendingController();
    usePlayerStore.setState({ repeatMode: "all" });
    player().startSongRadio(song("seed"));
    await tick();
    player().next();
    expect(player().songRadio?.waiting).toBe(true);
    expect(upcoming()).toEqual([]);
    requests[0].resolve([song("a"), song("b"), song("c"), song("d")]);
    await tick();
    expect(player().currentSong?.id).toBe("a");
    expect(player().isPlaying).toBe(true);
  });

  test("pausing while a late batch is pending prevents unexpected playback", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed"));
    await tick();
    player().next(); player().pause();
    requests[0].resolve([song("a"), song("b"), song("c")]);
    await tick();
    expect(player().currentSong?.id).toBe("seed");
    expect(player().isPlaying).toBe(false);
    expect(upcoming()).toEqual(["a", "b", "c"]);
  });

  test("manual music queued during a slow request plays first, then continues related music", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed"));
    await tick();
    player().next(); player().addToQueue(song("manual"));
    await tick();
    expect(player().currentSong?.id).toBe("manual");
    requests[0].resolve([song("a"), song("b"), song("c")]);
    await tick();
    expect(player().currentSong?.id).toBe("manual");
    expect(upcoming()).toEqual(["a", "b", "c"]);
  });

  test("a new search aborts the old request even if its transport ignores cancellation", async () => {
    const requests = pendingController();
    player().startSongRadio(song("old")); await tick();
    player().startSongRadio(song("new")); await tick();
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve([song("wrong")]); await tick();
    expect(ids()).toEqual(["new"]);
    requests[1].resolve([song("a"), song("b"), song("c")]); await tick();
    expect(ids()).toEqual(["new", "a", "b", "c"]);
  });

  test("selecting a playlist cancels recommendations and preserves its order", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed")); await tick();
    player().setQueue([song("album1"), song("album2")], 0); await tick();
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve([song("wrong")]); await tick();
    expect(ids()).toEqual(["album1", "album2"]);
    expect(player().songRadio).toBeNull();
    player().next();
    expect(player().currentSong?.id).toBe("album2");
  });

  test("cleanup prevents a completed request from entering another account", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed")); await tick();
    stop!();
    requests[0].resolve([song("wrong")]); await tick();
    expect(requests[0].signal.aborted).toBe(true);
    expect(ids()).toEqual(["seed"]);
  });

  test("empty and failed requests do not loop, and the user can retry", async () => {
    const requests = pendingController();
    player().startSongRadio(song("seed")); await tick();
    player().next();
    requests[0].resolve([]); await tick();
    player().setVolume(0.7); await tick();
    expect(player().songRadio?.status).toBe("unavailable");
    expect(player().songRadio?.waiting).toBe(false);
    expect(requests).toHaveLength(1);
    player().retrySongRadio(); await tick();
    expect(requests).toHaveLength(2);
    requests[1].reject(new Error("offline")); await tick();
    expect(requests).toHaveLength(2);
    expect(player().isPlaying).toBe(false);
  });

  test("duplicate recordings, removed suggestions, podcasts, and covers stay excluded", () => {
    player().startSongRadio(song("seed"));
    const token = player().songRadio!.token;
    player().appendSongRadio(token, [
      song("seed"), { ...song("copy"), title: "SONG-SEED", artist: "Artist seed" },
      { ...song("podcast"), source: "podcast" },
      { ...song("cover"), title: "A song (Karaoke Version)" }, song("a"), song("b"),
    ]);
    expect(ids()).toEqual(["seed", "a", "b"]);
    player().removeFromQueue(1);
    player().appendSongRadio(token, [song("a"), song("c")]);
    expect(ids()).toEqual(["seed", "b", "c"]);
    player().undoQueueRemoval();
    expect(ids()).toEqual(["seed", "a", "b", "c"]);
  });

  test("staging and media refresh preserve recommendation identity and metadata", () => {
    player().startSongRadio(song("seed"));
    const token = player().songRadio!.token;
    player().appendSongRadio(token, [{ ...song("a"), discoverTrackId: "catalog-a", audioUrl: "" }]);
    player().replaceStagedSong("a", { ...song("staged-a"), discoverTrackId: "catalog-a", duration: 180 });
    player().replaceSong({ ...song("staged-a"), discoverTrackId: "catalog-a", audioUrl: "/renewed.mp3", duration: 180 });
    expect(player().queue[1].recommended).toBe(true);
    expect(player().queue[1].duration).toBe(180);
    player().appendSongRadio(token, [{ ...song("another-copy"), discoverTrackId: "catalog-a" }]);
    expect(ids()).toEqual(["seed", "staged-a"]);
  });

  test("podcasts and live radio never start music recommendations", async () => {
    const requests = pendingController();
    player().startSongRadio({ ...song("episode"), source: "podcast" }); await tick();
    player().startSongRadio({ ...song("station"), source: "radio" }); await tick();
    expect(player().songRadio).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test("the real client uses the existing API and creates temporary previews with durations", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (url, options) => {
      expect(url).toBe("/api/smart-shuffle/recommend");
      expect(options?.credentials).toBe("include");
      body = JSON.parse(String(options?.body));
      return Response.json({ tracks: [{ id: "spotify-a", title: "Related", artist: "Another artist", imageUrl: "/cover.jpg", durationMs: 185000 }] });
    }) as typeof fetch;
    stop = startSongRadioController();
    player().startSongRadio(song("seed")); await tick();
    expect(body.limit).toBe(12);
    expect(player().queue[1]).toMatchObject({
      id: "discover:spotify-a", discoverTrackId: "spotify-a", duration: 185,
      preview: true, recommended: true, audioUrl: "",
    });
  });
});
