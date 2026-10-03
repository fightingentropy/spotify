import { describe, expect, test } from "bun:test";
import { createApiDataCache } from "../src/client/api-data-cache";

type Result = { data: unknown; etag?: string | null };
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let time = 1_000;
  const requests: { url: string; cached?: { data?: unknown; etag?: string | null } }[] = [];
  const updates: { url: string; data: unknown }[] = [];
  const cache = createApiDataCache(async (url, cached) => {
    requests.push({ url, cached });
    return { data: { value: requests.length }, etag: `"${requests.length}"` };
  }, (url, data) => updates.push({ url, data }), { now: () => time });
  return { cache, requests, updates, advance: (ms: number) => { time += ms; } };
}

describe("website API data cache", () => {
  test("three quick Home visits need one request per endpoint, then stale data revalidates", async () => {
    const { cache, requests, advance } = setup();
    const urls = ["/api/home", "/api/stats/home", "/api/discover/playlists"];
    for (let visit = 0; visit < 3; visit++) {
      await Promise.all(urls.map((url) => cache.read(url)));
      advance(1_000);
    }
    expect(requests).toHaveLength(3);
    advance(30_000);
    await Promise.all(urls.map((url) => cache.read(url)));
    expect(requests.map((request) => request.url)).toEqual([...urls, "/api/home", "/api/stats/home"]);
    expect(requests[3]?.cached?.etag).toBe('"1"');
  });

  test("repeated search queries reuse results for one minute", async () => {
    const { cache, requests, advance } = setup();
    const url = "/api/search/catalog?q=hello&auth=one";
    const first = await cache.read<{ value: number }>(url);
    advance(59_999);
    expect(await cache.read<{ value: number }>(url)).toBe(first);
    expect(requests).toHaveLength(1);
    advance(1);
    expect(await cache.read<{ value: number }>(url)).not.toBe(first);
    expect(requests).toHaveLength(2);
  });

  test("concurrent readers and reconnects share one request even while a like is patched", async () => {
    const request = deferred();
    let calls = 0;
    const cache = createApiDataCache(async () => {
      calls++;
      if (calls === 1) return { data: { likedSongIds: [] }, etag: '"original"' };
      return request.promise;
    }, () => {});
    await cache.read("/api/home");
    const refresh = cache.read("/api/home", true);
    await Promise.resolve();
    const optimistic = { likedSongIds: ["new-song"] };
    cache.patch("/api/home", optimistic);
    const other = cache.read("/api/home", true);
    expect(other).toBe(refresh);
    expect(calls).toBe(2);
    request.resolve({ data: { likedSongIds: [] }, etag: '"original"' });
    expect(await refresh).toBe(optimistic);
    expect(cache.get("/api/home")?.data).toBe(optimistic);
    expect(cache.get("/api/home")?.etag).toBeNull();
  });

  test("online reconnect bypasses freshness while ordinary reads do not", async () => {
    const { cache, requests } = setup();
    await cache.read("/api/liked");
    await cache.read("/api/liked");
    expect(requests).toHaveLength(1);
    await cache.read("/api/liked", true);
    expect(requests).toHaveLength(2);
  });

  test("optimistic patches preserve the age of the rest of the payload", async () => {
    const { cache, requests, advance } = setup();
    await cache.read("/api/liked");
    advance(29_000);
    cache.patch("/api/liked", { likedSongIds: ["new-song"] });
    advance(1_000);
    await cache.read("/api/liked");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.cached?.etag).toBeNull();
  });

  test("an old request cannot repopulate or publish after auth/library invalidation", async () => {
    const request = deferred();
    const updates: unknown[] = [];
    const cache = createApiDataCache(() => request.promise, (_url, data) => updates.push(data));
    const pending = cache.read("/api/liked?auth=first");
    await Promise.resolve();
    cache.invalidate();
    request.resolve({ data: { likedSongIds: ["private"] } });
    await pending;
    expect(cache.get("/api/liked?auth=first")).toBeUndefined();
    expect(updates).toEqual([]);
  });

  test("an old request cannot replace a newer explicit retry", async () => {
    const oldRequest = deferred();
    let calls = 0;
    const cache = createApiDataCache(async () => ++calls === 1 ? oldRequest.promise : { data: "new" }, () => {});
    const pending = cache.read("/api/liked");
    await Promise.resolve();
    cache.invalidate((url) => url === "/api/liked");
    expect(await cache.read<string>("/api/liked")).toBe("new");
    oldRequest.resolve({ data: "old" });
    await pending;
    expect(cache.get("/api/liked")?.data).toBe("new");
  });

  test("account-scoped URLs never share cached responses", async () => {
    const { cache, requests } = setup();
    const first = await cache.read("/api/liked?auth=first");
    const second = await cache.read("/api/liked?auth=second");
    expect(first).not.toBe(second);
    expect(requests).toHaveLength(2);
  });

  test("failed requests are retryable and do not occupy cache entries", async () => {
    let calls = 0;
    const cache = createApiDataCache(async () => {
      if (++calls === 1) throw new Error("offline");
      return { data: "recovered" };
    }, () => {});
    await expect(cache.read("/api/home")).rejects.toThrow("offline");
    expect(cache.entries()).toEqual([]);
    expect(await cache.read<string>("/api/home")).toBe("recovered");
  });

  test("keeps only the most recently used results without evicting an active request", async () => {
    const pending = deferred();
    const cache = createApiDataCache(async (url) => url === "pending" ? pending.promise : { data: url }, () => {}, { maxEntries: 2 });
    const active = cache.read("pending");
    await cache.read("first");
    await cache.read("second");
    expect(cache.get("first")).toBeUndefined();
    expect(cache.read("pending")).toBe(active);
    expect(cache.entries()).toHaveLength(2);
    pending.resolve({ data: "ready" });
    await active;
    expect(cache.get("pending")?.data).toBe("ready");
  });
});
