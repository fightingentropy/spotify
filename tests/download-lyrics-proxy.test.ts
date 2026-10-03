import { describe, expect, test } from "bun:test";
import { fetchLrclibLyrics } from "../src/lib/download-lyrics";
import { handleDownloadLyrics } from "../src/server/download-lyrics";
import { createPrivateProxyAuthenticator } from "../src/server/proxy-auth";
import { fetchMiniDownloadLyrics } from "../src/worker/download-lyrics";
import { createMacMiniProxyHeaders } from "../src/worker/mac-mini-proxy";

const env = { MAC_MINI_ORIGIN: "https://private.example.test", MAC_MINI_REQUEST_SIGNING_SECRET: "test-only-signing-secret" };
const user = { id: "test-account", email: "test@example.test", name: "Test" };
const lyrics = "[00:01.00]First synthetic line\n[00:30.00]Second synthetic line\n[01:00.00]Third synthetic line\n[01:50.00]Fourth synthetic line";
const metadata = { title: "Example", artist: "Artist", album: "Album", durationMs: 120_000, titleFallback: false };
const request = (body: unknown) => new Request("https://private.example.test/api/downloads/lyrics", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

describe("private-host download lyrics", () => {
  test("requires an authenticated user before reading or resolving metadata", async () => {
    let called = false;
    const result = await handleDownloadLyrics(request(metadata), null, async () => { called = true; return lyrics; });
    expect(result.status).toBe(401);
    expect(called).toBe(false);
    expect(await fetchMiniDownloadLyrics(env, null, "Example", "Artist", {}, async () => { called = true; return Response.json({ lyrics }); })).toBe("");
    expect(called).toBe(false);
  });

  test("signs the authenticated Mini request and only sends public metadata to LRCLIB", async () => {
    const result = await fetchMiniDownloadLyrics(env, user, "Example", "Artist", metadata, async options => {
      expect(options.target).toBe("/api/downloads/lyrics");
      expect(options.redirect).toBe("manual");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const headers = await createMacMiniProxyHeaders({ env, method: "POST", target: options.target, user: options.user, sourceHeaders: options.headers });
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      const incoming = new Request("https://private.example.test/api/downloads/lyrics", { method: "POST", headers, body: options.body });
      const auth = createPrivateProxyAuthenticator({ requestSigningSecret: env.MAC_MINI_REQUEST_SIGNING_SECRET }).authenticate(incoming);
      expect(auth.authenticated).toBe(true);
      expect(auth.identity?.id).toBe(user.id);
      return handleDownloadLyrics(incoming, auth.identity?.id || null, (title, artist, lookupOptions) => {
        expect(lookupOptions?.titleFallback).toBe(false);
        return fetchLrclibLyrics(title, artist, lookupOptions, async (url, init) => {
          expect(new URL(url).hostname).toBe("lrclib.net");
          expect(new Headers(init.headers).get("cookie")).toBeNull();
          expect(new Headers(init.headers).get("authorization")).toBeNull();
          expect(new Headers(init.headers).get("x-spotify-user-id")).toBeNull();
          return Response.json({ trackName: title, artistName: artist, duration: 120, syncedLyrics: lyrics });
        });
      });
    });
    expect(result).toBe(lyrics);
  });

  test("returns an honest miss and leaves Worker fallback available", async () => {
    const missing = await handleDownloadLyrics(request(metadata), user.id, async () => "");
    expect(missing.status).toBe(404);
    expect(await fetchMiniDownloadLyrics(env, user, "Example", "Artist", {}, async () => missing)).toBe("");
    expect(await fetchMiniDownloadLyrics(env, user, "Example", "Artist", {}, async () => { throw new Error("offline"); })).toBe("");
    expect(await fetchMiniDownloadLyrics({}, user, "Example", "Artist", {}, async () => { throw new Error("must not call an unconfigured host"); })).toBe("");
  });

  test("bounds caller metadata before external lookup", async () => {
    let calls = 0;
    for (const payload of [{ ...metadata, title: "x".repeat(513) }, { ...metadata, durationMs: -1 }, { ...metadata, extra: "x".repeat(16 * 1024) }, []]) {
      const result = await handleDownloadLyrics(request(payload), user.id, async () => { calls += 1; return lyrics; });
      expect(result.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("rejects oversized or invalid upstream lyric responses", async () => {
    const excessive = await handleDownloadLyrics(request(metadata), user.id, async () => "x".repeat(256 * 1024 + 1));
    expect(excessive.status).toBe(502);
    for (const response of [new Response("x".repeat(512 * 1024 + 1)), Response.json({ lyrics: 123 }), new Response("not JSON"), new Response(null, { status: 302, headers: { location: "https://other.example.test" } })]) {
      expect(await fetchMiniDownloadLyrics(env, user, "Example", "Artist", {}, async () => response)).toBe("");
    }
  });
});
