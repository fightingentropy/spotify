import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLikesStore } from "../src/store/likes";
import { usePlayerStore } from "../src/store/player";
import type { PlayerSong } from "../src/types/player";
import { normalizeCatalogLike } from "../src/server/catalog-likes";

const originalFetch = globalThis.fetch;
const preview: PlayerSong = {
  id: "local-server:preview",
  title: "Let It Go",
  artist: "James Bay",
  imageUrl: "/cover.jpg",
  audioUrl: "/api/files/local/.discover/track/preview.opus",
  discoverTrackId: "40EB7ABUO6MoWMUwPKptJ7",
  preview: true,
};
const staged: PlayerSong = {
  ...preview,
  id: "local-server:lossless",
  audioUrl: "/api/files/local/.discover/track/song.flac",
  preview: false,
};
const saved: PlayerSong = {
  ...staged,
  id: "local-server:saved",
  audioUrl: "/api/files/local/song.flac",
  discoverTrackId: undefined,
};

describe("likes store", () => {
  beforeEach(() => {
    useLikesStore.setState({
      likedSongIds: {},
      pending: {},
      hydrated: true,
      error: null,
    });
    usePlayerStore.setState({ currentSong: preview, queue: [preview], currentIndex: 0, isPlaying: false });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("unliking a remote song sends DELETE and updates local state", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    useLikesStore.setState({
      likedSongIds: { "song-1": true },
      pending: {},
      hydrated: true,
    });

    const result = await useLikesStore.getState().toggleLike("song-1", false);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("DELETE");
    expect(useLikesStore.getState().likedSongIds["song-1"]).toBeUndefined();
  });

  test("liking a remote song sends POST and updates local state", async () => {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await useLikesStore.getState().toggleLike("song-2", true);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(useLikesStore.getState().likedSongIds["song-2"]).toBe(true);
  });

  test("failed unlike rolls back optimistic state", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    useLikesStore.setState({
      likedSongIds: { "song-3": true },
      pending: {},
      hydrated: true,
    });

    const result = await useLikesStore.getState().toggleLike("song-3", false);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe("nope");
    expect(useLikesStore.getState().likedSongIds["song-3"]).toBe(true);
    expect(useLikesStore.getState().pending["song-3"]).toBeUndefined();
  });

  for (const status of [409, 404]) {
    test(`liking a preview recovers from ${status}, saves the library copy, and keeps its heart`, async () => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        switch (requests.length) {
          case 1: return Response.json({ error: status === 409 ? "preview_not_lossless" : "Staged track not found" }, { status });
          case 2: return Response.json(staged);
          case 3: return Response.json(saved);
          case 4: return Response.json({ ok: true });
          default: throw new Error("Unexpected request");
        }
      }) as typeof fetch;

      const result = await useLikesStore.getState().toggleLike(preview.id, true, preview);

      expect(result.ok).toBe(true);
      expect(requests.map((request) => request.url)).toEqual([
        "/api/discover/promote", "/api/discover/stage", "/api/discover/promote", "/api/likes",
      ]);
      expect(requests[1].body.preview).not.toBe(true);
      expect(requests[1].body.spotifyUrl).toBe(`https://open.spotify.com/track/${preview.discoverTrackId}`);
      expect(requests[2].body.finalId).toBe(staged.id);
      expect(requests[3].body.songId).toBe(saved.id);
      expect(usePlayerStore.getState().currentSong).toEqual(saved);
      expect(usePlayerStore.getState().queue).toEqual([saved]);
      expect(useLikesStore.getState().likedSongIds).toEqual({ [saved.id]: true });
      expect(useLikesStore.getState().pending).toEqual({});
      expect(useLikesStore.getState().error).toBeNull();
      useLikesStore.getState().mergeInitial([saved.id]);
      expect(useLikesStore.getState().likedSongIds[saved.id]).toBe(true);
    });
  }

  test("keeps the heart pending through preparation and the final song id replacement", async () => {
    let finishStage!: (response: Response) => void;
    let finishSave!: (response: Response) => void;
    const preparation = new Promise<Response>((resolve) => { finishStage = resolve; });
    const save = new Promise<Response>((resolve) => { finishSave = resolve; });
    let promotions = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (url === "/api/discover/stage") return preparation;
      if (url === "/api/likes") return save;
      return ++promotions === 1
        ? Response.json({ error: "preview_not_lossless" }, { status: 409 })
        : Response.json(saved);
    }) as typeof fetch;

    let replacementState: { liked?: true; pending?: true } | undefined;
    let didReplace!: () => void;
    const replacement = new Promise<void>((resolve) => { didReplace = resolve; });
    const unsubscribe = usePlayerStore.subscribe((state) => {
      if (state.currentSong?.id !== saved.id) return;
      const likes = useLikesStore.getState();
      replacementState = { liked: likes.likedSongIds[saved.id], pending: likes.pending[saved.id] };
      didReplace();
    });
    try {
      const result = useLikesStore.getState().toggleLike(preview.id, true, preview);
      useLikesStore.getState().mergeInitial([]);
      expect(useLikesStore.getState().likedSongIds[preview.id]).toBe(true);
      expect(useLikesStore.getState().pending[preview.id]).toBe(true);
      expect(usePlayerStore.getState().currentSong).toEqual(preview);

      finishStage(Response.json(staged));
      await replacement;
      expect(replacementState).toEqual({ liked: true, pending: true });
      useLikesStore.getState().mergeInitial([]);
      expect(useLikesStore.getState().likedSongIds[saved.id]).toBe(true);

      finishSave(Response.json({ ok: true }));
      expect((await result).ok).toBe(true);
      expect(useLikesStore.getState().pending).toEqual({});
    } finally {
      unsubscribe();
      finishStage(Response.json(staged));
      finishSave(Response.json({ ok: true }));
    }
  });

  test("failed preparation and metadata save roll back the heart and explain the failure", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return url === "/api/discover/promote"
        ? Response.json({ error: "preview_not_lossless" }, { status: 409 })
        : Response.json({ error: "Source unavailable" }, { status: 502 });
    }) as typeof fetch;

    expect((await useLikesStore.getState().toggleLike(preview.id, true, preview)).ok).toBe(false);
    expect(urls).toEqual(["/api/discover/promote", "/api/discover/stage", "/api/likes"]);
    expect(useLikesStore.getState().likedSongIds).toEqual({});
    expect(useLikesStore.getState().pending).toEqual({});
    expect(usePlayerStore.getState().currentSong).toEqual(preview);
    expect(useLikesStore.getState().error).toContain("Couldn't save “Let It Go” to Liked Songs");
    useLikesStore.getState().clearError();
    expect(useLikesStore.getState().error).toBeNull();
  });

  test("a download outage saves a durable catalog like without interrupting its stream", async () => {
    const catalog = normalizeCatalogLike(preview)!;
    let saveBody: { songId?: string; song?: PlayerSong } = {};
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url === "/api/likes") {
        saveBody = JSON.parse(String(init?.body));
        return Response.json({ ok: true, song: catalog });
      }
      return Response.json({ error: "Source overloaded" }, { status: url === "/api/discover/promote" ? 409 : 503 });
    }) as typeof fetch;

    expect((await useLikesStore.getState().toggleLike(preview.id, true, preview)).ok).toBe(true);
    expect(saveBody.song?.discoverTrackId).toBe(preview.discoverTrackId);
    expect(useLikesStore.getState().likedSongIds).toEqual({ [catalog.id]: true });
    expect(useLikesStore.getState().pending).toEqual({});
    expect(useLikesStore.getState().error).toBeNull();
    expect(usePlayerStore.getState().currentSong?.id).toBe(catalog.id);
    expect(usePlayerStore.getState().currentSong?.audioUrl).toBe(preview.audioUrl);
    useLikesStore.getState().mergeInitial([catalog.id]);
    expect(useLikesStore.getState().likedSongIds[catalog.id]).toBe(true);

    // The same track in search still uses its preview id. Unlike the saved
    // catalog identity, rather than failing against that temporary file id.
    expect((await useLikesStore.getState().toggleLike(preview.id, false, preview)).ok).toBe(true);
    expect(saveBody.songId).toBe(catalog.id);
    expect(useLikesStore.getState().likedSongIds).toEqual({});
  });

  test("an already-owned song is liked without preparing another copy", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return Response.json(url === "/api/discover/promote" ? saved : { ok: true });
    }) as typeof fetch;
    expect((await useLikesStore.getState().toggleLike(preview.id, true, preview)).ok).toBe(true);
    expect(urls).toEqual(["/api/discover/promote", "/api/likes"]);
    expect(useLikesStore.getState().likedSongIds).toEqual({ [saved.id]: true });
  });
});
