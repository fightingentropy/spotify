import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLikesStore } from "../src/store/likes";

const originalFetch = globalThis.fetch;

describe("likes store", () => {
  beforeEach(() => {
    useLikesStore.setState({
      likedSongIds: {},
      pending: {},
      hydrated: true,
    });
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
});
