import { describe, expect, test } from "bun:test";
import { createDiscoverCardCache, type DiscoverPlaylistCard } from "../src/worker/discover-card-cache";

const top = { id: "discover-top50", name: "Top 50", imageUrl: "", songsCount: 0 };
const mix = { id: "yt-mix-test", name: "Discover Mix", imageUrl: "", songsCount: 0 };
const resolvedTop = { ...top, imageUrl: "https://art.example/top.jpg", songsCount: 50 };
const resolvedMix = { ...mix, imageUrl: "https://art.example/personalized.jpg", songsCount: 25 };

function deferred() {
  let resolve!: (card: DiscoverPlaylistCard | null) => void;
  const promise = new Promise<DiscoverPlaylistCard | null>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let time = 1_000;
  const stored = new Map<string, string>();
  const jobs: Promise<unknown>[] = [];
  const cache: Pick<Cache, "match" | "put"> = {
    async match(request) {
      const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
      const value = stored.get(key);
      return value ? new Response(value) : undefined;
    },
    async put(request, response) {
      stored.set(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url, await response.text());
    },
  };
  const read = createDiscoverCardCache(() => time);
  const options = {
    requestUrl: "https://music.example/api/discover/playlists?auth=ignored-query",
    userId: "user-one" as string | null,
    privateOrigin: "https://mini.example",
    sources: [
      { fallback: top, load: async () => resolvedTop },
      { fallback: mix, authenticatedOnly: true, load: async () => resolvedMix },
    ],
    openCache: async () => cache,
    waitUntil: (work: Promise<unknown>) => { jobs.push(work); },
  };
  return { read, options, stored, jobs, advance: (ms: number) => { time += ms; }, drain: () => Promise.all(jobs.splice(0)) };
}

describe("Discover card metadata cache", () => {
  test("cold Home returns fallback cards while both providers remain unresolved", async () => {
    const { read, options, jobs, drain } = setup();
    const slowTop = deferred();
    const slowMix = deferred();
    const readOptions = { ...options, sources: [
      { fallback: top, load: () => slowTop.promise },
      { fallback: mix, authenticatedOnly: true, load: () => slowMix.promise },
    ] };
    const result = await read(readOptions);
    expect(result).toEqual({ playlists: [top, mix], fresh: false });
    expect(jobs).toHaveLength(1);
    slowTop.resolve(resolvedTop);
    slowMix.resolve(resolvedMix);
    await drain();
    expect(await read(readOptions)).toEqual({ playlists: [resolvedTop, resolvedMix], fresh: true });
  }, 1_000);

  test("stale cards return immediately and concurrent readers start only one refresh", async () => {
    const { read, options, jobs, drain, advance } = setup();
    await read(options);
    await drain();
    advance(600_001);
    const slow = deferred();
    let calls = 0;
    const staleOptions = { ...options, sources: [
      { fallback: top, load: () => { calls++; return slow.promise; } },
      options.sources[1]!,
    ] };
    const first = await read(staleOptions);
    const second = await read(staleOptions);
    expect(first).toEqual({ playlists: [resolvedTop, resolvedMix], fresh: false });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(jobs).toHaveLength(1);
    slow.resolve({ ...resolvedTop, imageUrl: "https://art.example/new.jpg" });
    await drain();
    expect((await read(staleOptions)).playlists[0]?.imageUrl).toBe("https://art.example/new.jpg");
  });

  test("partial provider failures preserve successful card metadata and retry after a short delay", async () => {
    const { read, options, jobs, drain, advance } = setup();
    await read(options);
    await drain();
    advance(600_001);
    const nextTop = { ...resolvedTop, imageUrl: "https://art.example/new-top.jpg" };
    const failedOptions = { ...options, sources: [
      { fallback: top, load: async () => nextTop },
      { fallback: mix, authenticatedOnly: true, load: async () => { throw new Error("mini unavailable"); } },
    ] };
    await read(failedOptions);
    await drain();
    expect((await read(failedOptions)).playlists).toEqual([nextTop, resolvedMix]);
    expect(jobs).toHaveLength(0);
    advance(30_001);
    await read(failedOptions);
    expect(jobs).toHaveLength(1);
    await drain();
  });

  test("empty provider reads retain cached cards instead of caching empty metadata", async () => {
    const { read, options, drain, advance } = setup();
    await read(options);
    await drain();
    advance(600_001);
    await read({ ...options, sources: options.sources.map((source) => ({ ...source, load: async () => null })) });
    await drain();
    expect((await read(options)).playlists).toEqual([resolvedTop, resolvedMix]);
  });

  test("exact users, private origins and anonymous sessions cannot share personalized cache entries", async () => {
    const { read, options, drain, stored } = setup();
    await read(options);
    await drain();
    for (const changed of [
      { userId: "user-two" }, { userId: "anonymous" }, { privateOrigin: "https://other-mini.example" },
    ]) {
      const result = await read({ ...options, ...changed });
      expect(result.playlists).toEqual([top, mix]);
      expect(result.fresh).toBe(false);
      await drain();
    }
    let privateCalls = 0;
    const anonymous = { ...options, userId: null, sources: [options.sources[0]!, {
      fallback: mix, authenticatedOnly: true, load: async () => { privateCalls++; return resolvedMix; },
    }] };
    expect((await read(anonymous)).playlists).toEqual([top]);
    await drain();
    expect((await read(anonymous)).playlists).toEqual([resolvedTop]);
    expect(privateCalls).toBe(0);
    expect(stored.size).toBe(5);
    expect([...stored.keys()].every((url) => !url.includes("user-one") && !url.includes("auth="))).toBe(true);
  });

  test("refresh deduplication is bounded to sixteen scopes and recovers after completion", async () => {
    const { read, options, jobs, drain } = setup();
    const slow = deferred();
    let calls = 0;
    const pendingOptions = { ...options, sources: [{ fallback: top, load: () => { calls++; return slow.promise; } }] };
    for (let index = 0; index < 20; index++) await read({ ...pendingOptions, userId: `user-${index}` });
    expect(calls).toBe(16);
    expect(jobs).toHaveLength(16);
    slow.resolve(resolvedTop);
    await drain();
    await read({ ...pendingOptions, userId: "user-20" });
    expect(jobs).toHaveLength(1);
    await drain();
  });

  test("cache failures do not turn a provider outage into a failed Home response", async () => {
    const { read, options, drain } = setup();
    const unavailable = { ...options, openCache: async () => { throw new Error("cache unavailable"); }, sources: [
      { fallback: top, load: async () => { throw new Error("catalog unavailable"); } },
    ] };
    expect(await read(unavailable)).toEqual({ playlists: [top], fresh: false });
    await drain();
    expect(await read(unavailable)).toEqual({ playlists: [top], fresh: false });
    await drain();
  });
});
