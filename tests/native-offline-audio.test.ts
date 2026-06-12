import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acquireNativeOfflineAudioObjectUrl,
  fetchNativeOfflineAudioBlob,
  isCapacitorFileUrl,
  releaseNativeOfflineAudioObjectUrl,
} from "../src/client/capacitor-offline";

const CAP_BASE = "capacitor://localhost/_capacitor_file_/var/mobile/Data/offline-media/song-1";

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let fetchCalls: string[] = [];
let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];

function mockFetch(blob: Blob, ok = true): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve(
      ok
        ? new Response(blob, { status: 200 })
        : new Response(null, { status: 404 }),
    );
  }) as typeof fetch;
}

// Response normalizes body content types, so fetchNativeOfflineAudioBlob sees the
// type the mock intends only if we return the blob directly from response.blob().
function mockFetchRawBlob(blob: Blob, ok = true): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      blob: () => Promise.resolve(blob),
    } as unknown as Response);
  }) as typeof fetch;
}

// iOS WebViewAssetHandler answers non-Range media requests with a bare
// URLResponse, which WebKit surfaces as a status-0 (not ok) Response.
function mockFetchStatusZero(blob: Blob): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.resolve({
      ok: false,
      status: 0,
      blob: () => Promise.resolve(blob),
    } as unknown as Response);
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  createdObjectUrls = [];
  revokedObjectUrls = [];
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:mock-${createdObjectUrls.length + 1}-${blob.size}`;
    createdObjectUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revokedObjectUrls.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("isCapacitorFileUrl", () => {
  test("detects scheme-handler file URLs", () => {
    expect(isCapacitorFileUrl(`${CAP_BASE}/audio.flac`)).toBe(true);
    expect(isCapacitorFileUrl("https://localhost/_capacitor_file_/x/audio.m4a")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isCapacitorFileUrl("capacitor://localhost/api/files/audio/song.flac")).toBe(false);
    expect(isCapacitorFileUrl("https://spotify.fightingentropy.org/api/files/audio.flac")).toBe(false);
    expect(isCapacitorFileUrl("blob:capacitor://localhost/abc")).toBe(false);
    expect(isCapacitorFileUrl("")).toBe(false);
    expect(isCapacitorFileUrl(null)).toBe(false);
    expect(isCapacitorFileUrl(undefined)).toBe(false);
  });
});

describe("fetchNativeOfflineAudioBlob", () => {
  test("rewraps an empty-type blob using the extension MIME map", async () => {
    const cases: Array<[string, string]> = [
      ["audio.flac", "audio/flac"],
      ["audio.mp3", "audio/mpeg"],
      ["audio.m4a", "audio/mp4"],
      ["audio.wav", "audio/wav"],
      ["audio.ogg", "audio/ogg"],
      ["audio.opus", "audio/ogg"],
    ];
    for (const [name, expected] of cases) {
      mockFetchRawBlob(new Blob([new Uint8Array([1, 2, 3])]));
      const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/${name}`);
      expect(blob.type).toBe(expected);
    }
  });

  test("falls back to audio/flac for unknown or missing extensions", async () => {
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    expect((await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.bin`)).type).toBe("audio/flac");
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    expect((await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio`)).type).toBe("audio/flac");
  });

  test("resolves the extension even with query or hash suffixes", async () => {
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    expect((await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.mp3?__retry=5`)).type).toBe("audio/mpeg");
  });

  test("prefers the stored contentType over the extension", async () => {
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.bin`, "audio/aac");
    expect(blob.type).toBe("audio/aac");
  });

  test("ignores a stored octet-stream contentType", async () => {
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.mp3`, "application/octet-stream");
    expect(blob.type).toBe("audio/mpeg");
  });

  test("rewraps octet-stream blobs and preserves the bytes", async () => {
    const bytes = new Uint8Array([102, 76, 97, 67]);
    mockFetchRawBlob(new Blob([bytes], { type: "application/octet-stream" }));
    const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.flac`);
    expect(blob.type).toBe("audio/flac");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test("returns an already-typed blob as-is", async () => {
    const typed = new Blob([new Uint8Array([1, 2])], { type: "audio/flac" });
    mockFetchRawBlob(typed);
    const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.mp3`);
    expect(blob).toBe(typed);
  });

  test("throws on a non-ok response", async () => {
    mockFetch(new Blob([]), false);
    await expect(fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.flac`)).rejects.toThrow("404");
  });

  test("accepts an iOS status-0 response with a non-empty blob", async () => {
    const bytes = new Uint8Array([102, 76, 97, 67]);
    mockFetchStatusZero(new Blob([bytes]));
    const blob = await fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.flac`);
    expect(blob.type).toBe("audio/flac");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  test("throws on a status-0 response with an empty blob", async () => {
    mockFetchStatusZero(new Blob([]));
    await expect(fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.flac`)).rejects.toThrow("no data");
  });

  test("throws on an ok response with an empty blob", async () => {
    mockFetchRawBlob(new Blob([]));
    await expect(fetchNativeOfflineAudioBlob(`${CAP_BASE}/audio.flac`)).rejects.toThrow("no data");
  });
});

describe("native offline audio object-URL cache", () => {
  test("caches by src: one fetch, one createObjectURL, stable URL", async () => {
    const src = `${CAP_BASE}/cache-hit/audio.flac`;
    mockFetchRawBlob(new Blob([new Uint8Array([1, 2, 3])]));
    const first = await acquireNativeOfflineAudioObjectUrl(src);
    const second = await acquireNativeOfflineAudioObjectUrl(src);
    expect(second).toBe(first);
    expect(fetchCalls).toHaveLength(1);
    expect(createdObjectUrls).toHaveLength(1);
    releaseNativeOfflineAudioObjectUrl(src);
  });

  test("release revokes the object URL and evicts the cache entry", async () => {
    const src = `${CAP_BASE}/release/audio.flac`;
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    const url = await acquireNativeOfflineAudioObjectUrl(src);
    releaseNativeOfflineAudioObjectUrl(src);
    expect(revokedObjectUrls).toEqual([url]);

    // Evicted: the next acquire re-fetches and mints a fresh URL.
    const again = await acquireNativeOfflineAudioObjectUrl(src);
    expect(again).not.toBe(url);
    expect(fetchCalls).toHaveLength(2);
    releaseNativeOfflineAudioObjectUrl(src);
  });

  test("release is a no-op for unknown srcs and never revokes twice", async () => {
    const src = `${CAP_BASE}/noop/audio.flac`;
    releaseNativeOfflineAudioObjectUrl(src);
    expect(revokedObjectUrls).toHaveLength(0);

    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    await acquireNativeOfflineAudioObjectUrl(src);
    releaseNativeOfflineAudioObjectUrl(src);
    releaseNativeOfflineAudioObjectUrl(src);
    expect(revokedObjectUrls).toHaveLength(1);
  });

  test("entries are independent: releasing one src leaves the other alive", async () => {
    const srcA = `${CAP_BASE}/independent-a/audio.flac`;
    const srcB = `${CAP_BASE}/independent-b/audio.flac`;
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    const urlA = await acquireNativeOfflineAudioObjectUrl(srcA);
    const urlB = await acquireNativeOfflineAudioObjectUrl(srcB);
    expect(urlA).not.toBe(urlB);

    releaseNativeOfflineAudioObjectUrl(srcA);
    expect(revokedObjectUrls).toEqual([urlA]);
    expect(await acquireNativeOfflineAudioObjectUrl(srcB)).toBe(urlB);
    releaseNativeOfflineAudioObjectUrl(srcB);
    expect(revokedObjectUrls).toEqual([urlA, urlB]);
  });

  test("concurrent acquires of the same src share one object URL", async () => {
    const src = `${CAP_BASE}/concurrent/audio.flac`;
    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    const [first, second] = await Promise.all([
      acquireNativeOfflineAudioObjectUrl(src),
      acquireNativeOfflineAudioObjectUrl(src),
    ]);
    expect(second).toBe(first);
    expect(createdObjectUrls).toHaveLength(1);
    releaseNativeOfflineAudioObjectUrl(src);
  });

  test("a failed fetch caches nothing", async () => {
    const src = `${CAP_BASE}/failed/audio.flac`;
    mockFetch(new Blob([]), false);
    await expect(acquireNativeOfflineAudioObjectUrl(src)).rejects.toThrow();
    expect(createdObjectUrls).toHaveLength(0);

    mockFetchRawBlob(new Blob([new Uint8Array([1])]));
    await acquireNativeOfflineAudioObjectUrl(src);
    expect(createdObjectUrls).toHaveLength(1);
    releaseNativeOfflineAudioObjectUrl(src);
  });
});
