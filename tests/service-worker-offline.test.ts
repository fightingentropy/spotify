import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type FetchHandler = (event: {
  request: Request;
  respondWith: (response: Promise<Response> | Response) => void;
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

type Runtime = {
  caches: MemoryCaches;
  fetchCalls: string[];
  handlers: Record<string, FetchHandler[]>;
  origin: string;
};

class MemoryCache {
  private entries = new Map<string, Response>();

  constructor(private readonly origin: string) {}

  private key(input: RequestInfo | URL, options?: { ignoreSearch?: boolean }): string {
    const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, this.origin);
    if (options?.ignoreSearch) url.search = "";
    return url.toString();
  }

  async match(input: RequestInfo | URL, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const key = this.key(input, options);
    const exact = this.entries.get(key);
    if (exact) return exact.clone();
    if (!options?.ignoreSearch) return undefined;
    for (const [storedKey, response] of this.entries.entries()) {
      const stored = new URL(storedKey);
      const requested = new URL(key);
      if (stored.origin === requested.origin && stored.pathname === requested.pathname) {
        return response.clone();
      }
    }
    return undefined;
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(input), response.clone());
  }

  async keys(): Promise<Request[]> {
    return Array.from(this.entries.keys()).map((url) => new Request(url));
  }

  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(input));
  }

  async add(input: RequestInfo | URL): Promise<void> {
    await this.put(input, new Response("", { status: 200 }));
  }
}

class MemoryCaches {
  private stores = new Map<string, MemoryCache>();

  constructor(private readonly origin: string) {}

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache(this.origin);
      this.stores.set(name, cache);
    }
    return cache;
  }

  async match(input: RequestInfo | URL, options?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    for (const cache of this.stores.values()) {
      const response = await cache.match(input, options);
      if (response) return response;
    }
    return undefined;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.stores.keys());
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

function cacheVersion(): string {
  const source = readFileSync(resolve(import.meta.dir, "../public/sw.js"), "utf8");
  const version = source.match(/CACHE_VERSION = "([^"]+)"/)?.[1];
  if (!version) throw new Error("Could not read service worker cache version");
  return version;
}

function createRuntime(): Runtime {
  const origin = "https://spotify.test";
  const handlers: Record<string, FetchHandler[]> = {};
  const caches = new MemoryCaches(origin);
  const fetchCalls: string[] = [];
  const self = {
    location: new URL(`${origin}/`),
    navigator: { onLine: false },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type: string, handler: FetchHandler) => {
      handlers[type] ??= [];
      handlers[type].push(handler);
    },
  };
  const source = readFileSync(resolve(import.meta.dir, "../public/sw.js"), "utf8");
  const fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    fetchCalls.push(url);
    throw new Error("Network should not be used while known offline");
  };

  new Function(
    "self",
    "caches",
    "fetch",
    "Response",
    "Request",
    "URL",
    "Headers",
    "Blob",
    "setTimeout",
    "clearTimeout",
    source,
  )(self, caches, fetch, Response, Request, URL, Headers, Blob, setTimeout, clearTimeout);

  return { caches, fetchCalls, handlers, origin };
}

function navigationRequest(url: string): Request {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { configurable: true, value: "navigate" });
  return request;
}

async function dispatchFetch(runtime: Runtime, request: Request): Promise<Response> {
  let responsePromise: Promise<Response> | undefined;
  const event = {
    request,
    respondWith: (response: Promise<Response> | Response) => {
      responsePromise = Promise.resolve(response);
    },
    waitUntil: () => {},
  };
  for (const handler of runtime.handlers.fetch ?? []) handler(event);
  expect(responsePromise).toBeDefined();
  return responsePromise!;
}

describe("service worker offline boot", () => {
  test("serves cached app shell for navigation without touching network", async () => {
    const runtime = createRuntime();
    const shellCache = await runtime.caches.open(`${cacheVersion()}-shell`);
    await shellCache.put("/", new Response("<!doctype html><title>cached shell</title>", {
      headers: { "content-type": "text/html" },
    }));

    const response = await dispatchFetch(runtime, navigationRequest(`${runtime.origin}/library`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("cached shell");
    expect(runtime.fetchCalls).toEqual([]);
  });

  test("serves cached API data while offline without refresh fetches", async () => {
    const runtime = createRuntime();
    const runtimeCache = await runtime.caches.open(`${cacheVersion()}-runtime`);
    await runtimeCache.put(`${runtime.origin}/api/home?auth=user-1`, new Response(JSON.stringify({ songs: [] }), {
      headers: { "content-type": "application/json", "content-length": "12" },
    }));

    const response = await dispatchFetch(runtime, new Request(`${runtime.origin}/api/home?auth=user-1`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ songs: [] });
    expect(runtime.fetchCalls).toEqual([]);
  });

  test("returns an offline JSON miss for uncached API data without touching network", async () => {
    const runtime = createRuntime();
    const response = await dispatchFetch(runtime, new Request(`${runtime.origin}/api/search-index?auth=user-1`));
    const payload = await response.json() as { offline?: boolean };

    expect(response.status).toBe(503);
    expect(payload.offline).toBe(true);
    expect(runtime.fetchCalls).toEqual([]);
  });
});
