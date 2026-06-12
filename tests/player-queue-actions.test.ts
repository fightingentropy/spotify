import { beforeEach, describe, expect, test } from "bun:test";
import { usePlayerStore } from "../src/store/player";
import type { PlayerSong } from "../src/types/player";

function song(id: string): PlayerSong {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    imageUrl: `https://example.com/${id}.jpg`,
    audioUrl: `https://example.com/${id}.mp3`,
  };
}

function songs(...ids: string[]): PlayerSong[] {
  return ids.map(song);
}

function queueIds(): string[] {
  return usePlayerStore.getState().queue.map((item) => item.id);
}

function idsAt(indices: number[]): string[] {
  const { queue } = usePlayerStore.getState();
  return indices.map((index) => queue[index]?.id ?? `<invalid:${index}>`);
}

beforeEach(() => {
  usePlayerStore.setState({
    queue: [],
    currentIndex: -1,
    currentSong: null,
    playHistory: [],
    playFuture: [],
    shuffleRemaining: [],
    isPlaying: false,
    shuffle: false,
    repeatMode: "off",
  });
});

describe("addToQueue", () => {
  test("on an empty queue makes the song current without starting playback", () => {
    const track = song("a");
    usePlayerStore.getState().addToQueue(track);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([track]);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong).toEqual(track);
    expect(state.isPlaying).toBe(false);
  });

  test("appends without disturbing the current song in linear mode", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });

    usePlayerStore.getState().addToQueue(song("d"));

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "c", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
    expect(state.shuffleRemaining).toEqual([]);
  });

  test("makes the appended index shuffle-eligible when shuffle is on", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentSong: queue[0],
      shuffle: true,
      shuffleRemaining: [1, 2],
    });

    usePlayerStore.getState().addToQueue(song("d"));

    const state = usePlayerStore.getState();
    expect(state.shuffleRemaining).toEqual([1, 2, 3]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["b", "c", "d"]);
  });
});

describe("playNext", () => {
  test("on an empty queue behaves like addToQueue", () => {
    const track = song("a");
    usePlayerStore.getState().playNext(track);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([track]);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong).toEqual(track);
    expect(state.isPlaying).toBe(false);
  });

  test("inserts after the current song in linear mode and next() plays it", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });

    usePlayerStore.getState().playNext(song("x"));
    expect(queueIds()).toEqual(["a", "b", "x", "c"]);
    expect(usePlayerStore.getState().currentSong?.id).toBe("b");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentIndex).toBe(2);
    expect(usePlayerStore.getState().currentSong?.id).toBe("x");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentSong?.id).toBe("c");
  });

  test("remaps playHistory/playFuture/shuffleRemaining under shuffle", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      playHistory: [0, 2],
      playFuture: [3],
      shuffleRemaining: [2, 3],
    });

    usePlayerStore.getState().playNext(song("x"));

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "x", "c", "d"]);
    // Stored indices still point at the same songs they did before the splice.
    expect(idsAt(state.playHistory)).toEqual(["a", "c"]);
    expect(state.playHistory).toEqual([0, 3]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["c", "d"]);
    expect(state.shuffleRemaining).toEqual([3, 4]);
    // The inserted index is pushed onto the redo stack so next() plays it.
    expect(state.playFuture).toEqual([4, 2]);
    expect(idsAt(state.playFuture)).toEqual(["d", "x"]);
  });

  test("plays next under shuffle without touching the shuffle pool", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      shuffleRemaining: [0, 2, 3],
    });

    usePlayerStore.getState().playNext(song("x"));
    usePlayerStore.getState().next();

    const state = usePlayerStore.getState();
    expect(state.currentSong?.id).toBe("x");
    expect(state.currentIndex).toBe(2);
    expect(state.playFuture).toEqual([]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["a", "c", "d"]);
    expect(state.playHistory).toEqual([1]);
  });
});

describe("removeFromQueue", () => {
  test("refuses the current index and out-of-range indices", () => {
    const queue = songs("a", "b", "c");
    usePlayerStore.setState({ queue, currentIndex: 1, currentSong: queue[1] });
    const before = usePlayerStore.getState();

    usePlayerStore.getState().removeFromQueue(1);
    usePlayerStore.getState().removeFromQueue(-1);
    usePlayerStore.getState().removeFromQueue(3);
    usePlayerStore.getState().removeFromQueue(1.5);

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual(before.queue);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
  });

  test("removing before the current index shifts currentIndex and remaps stored indices", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 2,
      currentSong: queue[2],
      shuffle: true,
      playHistory: [0, 1],
      playFuture: [3],
      shuffleRemaining: [0, 3],
    });

    usePlayerStore.getState().removeFromQueue(0);

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["b", "c", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("c");
    expect(state.queue[state.currentIndex]?.id).toBe("c");
    // Index 0 (the removed song) is dropped everywhere; the rest shift down.
    expect(state.playHistory).toEqual([0]);
    expect(idsAt(state.playHistory)).toEqual(["b"]);
    expect(state.playFuture).toEqual([2]);
    expect(idsAt(state.playFuture)).toEqual(["d"]);
    expect(state.shuffleRemaining).toEqual([2]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["d"]);
  });

  test("removing after the current index leaves currentIndex alone", () => {
    const queue = songs("a", "b", "c", "d");
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentSong: queue[1],
      shuffle: true,
      playHistory: [0],
      playFuture: [3],
      shuffleRemaining: [2, 3],
    });

    usePlayerStore.getState().removeFromQueue(2);

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["a", "b", "d"]);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong?.id).toBe("b");
    expect(state.playHistory).toEqual([0]);
    expect(state.playFuture).toEqual([2]);
    expect(idsAt(state.playFuture)).toEqual(["d"]);
    expect(state.shuffleRemaining).toEqual([2]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["d"]);
  });
});

describe("queue mutation shuffle invariants", () => {
  test("a mixed sequence of mutations keeps stored indices valid and aimed at the same songs", () => {
    const queue = songs("a", "b", "c", "d", "e");
    usePlayerStore.setState({
      queue,
      currentIndex: 2,
      currentSong: queue[2],
      shuffle: true,
      playHistory: [0, 4],
      playFuture: [1],
      shuffleRemaining: [1, 3],
    });

    usePlayerStore.getState().playNext(song("x")); // insert at 3
    usePlayerStore.getState().addToQueue(song("y")); // append at 6
    usePlayerStore.getState().removeFromQueue(0); // drop "a"

    const state = usePlayerStore.getState();
    expect(queueIds()).toEqual(["b", "c", "x", "d", "e", "y"]);
    expect(state.currentSong?.id).toBe("c");
    expect(state.queue[state.currentIndex]?.id).toBe("c");

    // "a" disappeared from history; the rest still target the original songs.
    expect(idsAt(state.playHistory)).toEqual(["e"]);
    expect(idsAt(state.playFuture)).toEqual(["b", "x"]);
    expect(idsAt(state.shuffleRemaining)).toEqual(["b", "d", "y"]);

    for (const indices of [state.playHistory, state.playFuture, state.shuffleRemaining]) {
      for (const index of indices) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(state.queue.length);
      }
    }
    expect(new Set(state.shuffleRemaining).size).toBe(state.shuffleRemaining.length);
    expect(state.shuffleRemaining).not.toContain(state.currentIndex);
  });
});
