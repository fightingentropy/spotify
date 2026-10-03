import { afterEach, describe, expect, test } from "bun:test";
import {
  isPlaybackNetworkTemporarilyPoor,
  notePlaybackNetworkSuccess,
  prefetchUpcomingPlayback,
} from "../src/client/playback-warm";
import type { PlayerSong } from "../src/types/player";

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function replaceGlobal(key: string, value: unknown): void {
  if (!originalDescriptors.has(key)) originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function browser(options: { saveData?: boolean; online?: boolean } = {}): void {
  replaceGlobal("window", globalThis);
  replaceGlobal("location", { origin: "https://music.example" });
  replaceGlobal("navigator", { onLine: options.online ?? true, connection: { saveData: options.saveData } });
  notePlaybackNetworkSuccess();
}

function song(id: string): PlayerSong {
  return {
    id, title: id, artist: "Artist",
    audioUrl: `/api/files/local/${id}.flac`,
    imageUrl: `/api/artwork/local/${id}?spotify_sig=private-signature&spotify_exp=1900000000`,
    lyricsUrl: `/api/files/local/${id}.lrc`,
  };
}

afterEach(() => {
  notePlaybackNetworkSuccess();
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  originalDescriptors.clear();
});

describe("upcoming playback warming", () => {
  test("warms small signed artwork in the reusable HTTP cache without writing CacheStorage", async () => {
    browser();
    const requests: { url: string; options?: RequestInit }[] = [];
    let cacheStorageCalls = 0;
    replaceGlobal("caches", { open: () => { cacheStorageCalls++; throw new Error("Unused cache"); } });
    replaceGlobal("fetch", async (url: string, options?: RequestInit) => {
      requests.push({ url, options });
      return new Response("media", { status: 200 });
    });
    await prefetchUpcomingPlayback([song("playing"), song("small-art")], 0);
    expect(requests).toHaveLength(3);
    expect(new Headers(requests[0]?.options?.headers).get("range")).toBe("bytes=0-524287");
    const artwork = requests.find((request) => request.url.includes("/artwork/"))!;
    const url = new URL(artwork.url);
    expect(url.searchParams.get("w")).toBe("128");
    expect(url.searchParams.get("spotify_sig")).toBe("private-signature");
    expect(url.searchParams.get("spotify_exp")).toBe("1900000000");
    expect(artwork.options?.cache).toBe("force-cache");
    expect(artwork.options?.credentials).toBe("include");
    expect(cacheStorageCalls).toBe(0);
  });

  test("does no speculative work for data saver, offline, or an already cancelled playback", async () => {
    let calls = 0;
    replaceGlobal("fetch", async () => { calls++; return new Response("media"); });
    const queue = [song("playing"), song("skipped")];
    browser({ saveData: true });
    await prefetchUpcomingPlayback(queue, 0);
    browser({ online: false });
    await prefetchUpcomingPlayback(queue, 0);
    browser();
    const controller = new AbortController();
    controller.abort();
    await prefetchUpcomingPlayback(queue, 0, undefined, controller.signal);
    expect(calls).toBe(0);
  });

  test("pausing cancels the active warm and prevents later audio/artwork without network backoff", async () => {
    browser();
    const requests: string[] = [];
    const controller = new AbortController();
    replaceGlobal("fetch", (url: string, options?: RequestInit) => {
      requests.push(url);
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const warming = prefetchUpcomingPlayback(
      [song("playing"), song("cancel-one"), song("cancel-two")], 0, undefined, controller.signal,
    );
    expect(requests).toHaveLength(1);
    controller.abort();
    await warming;
    expect(requests).toHaveLength(1);
    expect(isPlaybackNetworkTemporarilyPoor()).toBe(false);
  });

  test("does not prefetch private media from a different origin or browser-local tracks", async () => {
    browser();
    let calls = 0;
    replaceGlobal("fetch", async () => { calls++; return new Response("media"); });
    await prefetchUpcomingPlayback([
      song("playing"),
      { ...song("external"), audioUrl: "https://elsewhere.example/audio", imageUrl: "https://elsewhere.example/cover", lyricsUrl: undefined },
      { ...song("browser-local:one"), source: "browser-local" },
    ], 0);
    expect(calls).toBe(0);
  });
});
