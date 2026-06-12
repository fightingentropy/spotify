import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLikesStore } from "../src/store/likes";
import { useOfflineStore, type DownloadScope } from "../src/client/offline";
import type { PlayerSong } from "../src/types/player";

const originalFetch = globalThis.fetch;
const originalQueueDownloads = useOfflineStore.getState().queueDownloads;
const originalUnpinScope = useOfflineStore.getState().unpinScope;
const originalAutoDownloadLiked = useOfflineStore.getState().autoDownloadLiked;

const song: PlayerSong = {
  id: "song-1",
  title: "Song One",
  artist: "Artist",
  imageUrl: "/api/image/song-1",
  audioUrl: "/api/audio/song-1",
};

let queueCalls: Array<{ songs: PlayerSong[]; scope: DownloadScope }> = [];
let unpinCalls: Array<{ songId: string; scope: DownloadScope }> = [];

function mockLikeFetch(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("auto-download liked songs", () => {
  beforeEach(() => {
    queueCalls = [];
    unpinCalls = [];
    useLikesStore.setState({ likedSongIds: {}, pending: {}, hydrated: true });
    useOfflineStore.setState({
      autoDownloadLiked: true,
      queueDownloads: async (songs, scope) => {
        queueCalls.push({ songs, scope });
      },
      unpinScope: async (songId, scope) => {
        unpinCalls.push({ songId, scope });
      },
    });
    mockLikeFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useOfflineStore.setState({
      autoDownloadLiked: originalAutoDownloadLiked,
      queueDownloads: originalQueueDownloads,
      unpinScope: originalUnpinScope,
    });
  });

  test("preference defaults to off outside the browser", () => {
    expect(originalAutoDownloadLiked).toBe(false);
  });

  test("setAutoDownloadLiked flips the store flag", () => {
    useOfflineStore.getState().setAutoDownloadLiked(false);
    expect(useOfflineStore.getState().autoDownloadLiked).toBe(false);
    useOfflineStore.getState().setAutoDownloadLiked(true);
    expect(useOfflineStore.getState().autoDownloadLiked).toBe(true);
  });

  test("liking with the preference on queues a download pinned by liked", async () => {
    const result = await useLikesStore.getState().toggleLike(song.id, true, song);

    expect(result.ok).toBe(true);
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].scope).toBe("liked");
    expect(queueCalls[0].songs.map((item) => item.id)).toEqual([song.id]);
    expect(unpinCalls).toHaveLength(0);
  });

  test("unliking with the preference on unpins the liked scope", async () => {
    useLikesStore.setState({ likedSongIds: { [song.id]: true }, pending: {}, hydrated: true });

    const result = await useLikesStore.getState().toggleLike(song.id, false, song);

    expect(result.ok).toBe(true);
    expect(unpinCalls).toEqual([{ songId: song.id, scope: "liked" }]);
    expect(queueCalls).toHaveLength(0);
  });

  test("liking without a song payload skips the download but does not throw", async () => {
    const result = await useLikesStore.getState().toggleLike(song.id, true);

    expect(result.ok).toBe(true);
    expect(queueCalls).toHaveLength(0);
    expect(unpinCalls).toHaveLength(0);
  });

  test("unliking without a song payload still unpins", async () => {
    useLikesStore.setState({ likedSongIds: { [song.id]: true }, pending: {}, hydrated: true });

    const result = await useLikesStore.getState().toggleLike(song.id, false);

    expect(result.ok).toBe(true);
    expect(unpinCalls).toEqual([{ songId: song.id, scope: "liked" }]);
  });

  test("preference off leaves the offline store untouched", async () => {
    useOfflineStore.setState({ autoDownloadLiked: false });

    await useLikesStore.getState().toggleLike(song.id, true, song);
    useLikesStore.setState({ likedSongIds: { [song.id]: true }, pending: {}, hydrated: true });
    await useLikesStore.getState().toggleLike(song.id, false, song);

    expect(queueCalls).toHaveLength(0);
    expect(unpinCalls).toHaveLength(0);
  });

  test("failed like request does not queue a download", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await useLikesStore.getState().toggleLike(song.id, true, song);

    expect(result.ok).toBe(false);
    expect(queueCalls).toHaveLength(0);
    expect(unpinCalls).toHaveLength(0);
  });
});
