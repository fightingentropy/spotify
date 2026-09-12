import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { D1_SCHEMA_SQL } from "../src/lib/db-schema";
import type { PlaybackStateSnapshot } from "../src/lib/playback-state";
import worker from "../src/worker/index";
import { MAX_PLAYBACK_STATE_BYTES, MAX_PLAYBACK_STORAGE_BYTES } from "../src/worker/playback-state-storage";
import { readJson, sha256Hex } from "../src/worker/request";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function snapshot(count = 1): PlaybackStateSnapshot {
  const queue = Array.from({ length: count }, (_, index) => ({
    id: `local-server:track-${index}`,
    title: `Björk — Jóga ${index}`,
    artist: "Björk",
    album: "Homogenic",
    audioUrl: `/api/files/local/音楽/track-${index}.flac?spotify_exp=2000000000&spotify_sig=${index.toString(16).padStart(64, "0")}`,
    imageUrl: `/api/files/local/音楽/cover-${index}.jpg?spotify_exp=2000000000&spotify_sig=${index.toString(16).padStart(64, "0")}`,
    description: "音楽の説明".repeat(100),
    createdAt: "2026-09-12T12:00:00.000Z",
    duration: 302,
    audioBitDepth: 24,
    audioSampleRate: 96000,
    source: "server" as const,
  }));
  const currentIndex = Math.floor(count * 0.7);
  return {
    version: 1,
    accountScope: "user:listener",
    deviceId: "browser-device",
    queue,
    currentIndex,
    song: queue[currentIndex],
    currentTime: 132.75,
    isPlaying: false,
    updatedAt: 1000,
  };
}

async function harness() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.exec(D1_SCHEMA_SQL);
  sqlite.run('INSERT INTO "User" (id, email) VALUES (?, ?)', ["listener", "listener@example.com"]);
  sqlite.run('INSERT INTO "Session" (id, sessionToken, userId, expires) VALUES (?, ?, ?, ?)', [
    "session", await sha256Hex("test-session"), "listener", "2099-01-01",
  ]);
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: SQLQueryBindings[]) {
            return {
              async all() {
                return { success: true, results: sqlite.query(sql).all(...params), meta: {} };
              },
              async run() {
                sqlite.query(sql).run(...params);
                return { success: true, results: [], meta: {} };
              },
            };
          },
        };
      },
    },
  } as unknown as CloudflareEnv;
  const request = (state?: PlaybackStateSnapshot, cookie = "spotify_session=test-session") =>
    worker.fetch(new Request("https://music.streamarena.xyz/api/playback-state", {
      method: state ? "PUT" : "GET",
      headers: { "content-type": "application/json", cookie },
      body: state ? JSON.stringify({ state }) : undefined,
    }), env);
  const stored = () => (sqlite.query('SELECT stateJson FROM "PlaybackState"').get() as { stateJson: string } | null)?.stateJson;
  const seed = (stateJson: string) => sqlite.run(
    'INSERT OR REPLACE INTO "PlaybackState" (id, userId, deviceId, stateJson) VALUES (?, ?, ?, ?)',
    ["saved", "listener", "browser-device", stateJson],
  );
  return { request, stored, seed };
}

describe("playback state persistence", () => {
  test("saves and restores a 1,364-song queue above D1's raw row limit without losing metadata or position", async () => {
    const api = await harness();
    const state = snapshot(1364);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(2_000_000);
    const saved = await api.request(state);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ state });
    expect(Buffer.byteLength(api.stored()!)).toBeLessThan(MAX_PLAYBACK_STORAGE_BYTES);
    const restored = await api.request();
    expect(restored.headers.get("cache-control")).toBe("no-store");
    expect(await restored.json()).toEqual({ state });

    const stale = await api.request({ ...state, updatedAt: 999, currentTime: 1, deviceId: "other-device" });
    expect(await stale.json()).toEqual({ state });
    const advanced = { ...state, updatedAt: 1001, currentTime: 140 };
    expect((await api.request(advanced)).status).toBe(200);
    expect(await (await api.request()).json()).toEqual({ state: advanced });
  });

  test("reads legacy JSON, retains small snapshots, and requires an authenticated account", async () => {
    const api = await harness();
    const state = snapshot();
    api.seed(JSON.stringify(state));
    expect(await (await api.request()).json()).toEqual({ state });
    expect((await api.request(state)).status).toBe(200);
    expect(JSON.parse(api.stored()!)).toEqual(state);
    expect((await api.request(undefined, "")).status).toBe(401);
    expect((await api.request(state, "")).status).toBe(401);
  });

  test("rejects oversized requests and incompressible rows without overwriting the saved queue", async () => {
    const api = await harness();
    const state = snapshot();
    await api.request(state);
    const original = api.stored();
    for (const accountScope of ["a".repeat(MAX_PLAYBACK_STATE_BYTES), randomBytes(1_200_000).toString("hex")]) {
      const response = await api.request({ ...state, updatedAt: 1001, accountScope });
      expect(response.status).toBe(413);
      expect(api.stored()).toBe(original);
    }
    // deviceId is stored in its own uncompressed column as well as the snapshot.
    expect((await api.request({ ...state, deviceId: "a".repeat(MAX_PLAYBACK_STORAGE_BYTES) })).status).toBe(413);
    expect(api.stored()).toBe(original);
  });

  test("handles corrupt or oversized compressed snapshots without failing the restore endpoint", async () => {
    const api = await harness();
    for (const stored of ["not-json", "gzip-v1:broken", `gzip-v1:${gzipSync("a".repeat(MAX_PLAYBACK_STATE_BYTES + 1)).toString("base64")}`]) {
      api.seed(stored);
      const response = await api.request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: null });
    }
  });
});

describe("bounded JSON requests", () => {
  test("counts streamed UTF-8 bytes, cancels on overflow, and accepts a character split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: "音楽" }));
    let cancelled = false;
    const stream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
      },
      cancel() { cancelled = true; },
    });
    await expect(readJson(new Request("https://music.invalid", { method: "PUT", body: stream() }), bytes.length - 1))
      .rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
    const complete = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });
    expect(await readJson<{ title: string }>(new Request("https://music.invalid", { method: "PUT", body: complete }), bytes.length))
      .toEqual({ title: "音楽" });
  });

  test("rejects declared oversize bodies and returns null for malformed JSON", async () => {
    await expect(readJson(new Request("https://music.invalid", {
      method: "PUT", headers: { "content-length": "20" }, body: "{}",
    }), 10)).rejects.toMatchObject({ status: 413 });
    expect(await readJson(new Request("https://music.invalid", { method: "PUT", body: "{" }), 10)).toBeNull();
  });
});
