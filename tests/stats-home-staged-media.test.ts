import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { D1_SCHEMA_SQL } from "../src/lib/db-schema";
import type { PlayerSong } from "../src/types/player";
import worker from "../src/worker/index";
import { sha256Hex } from "../src/worker/request";

// Home history is refreshed by the Worker through the mini's /api/media/refresh.
// A staged Discover copy exists only in the shared root, so its fresh URLs must
// stay shared-scope even for a listener who is not a library owner.
const LISTENER_ID = "listener";
const STALE_AUTH = "spotify_user=local-mac-mini&spotify_scope=shared&spotify_exp=1000&spotify_sig=stale";
const STAGED_DIR = ".discover/yt_zg95do1LTdk";
const STAGED_COVER = `/api/files/local/${STAGED_DIR}/Ed%20Sheeran%20-%20Dive.cover.jpg`;
const STAGED_AUDIO = `/api/files/local/${STAGED_DIR}/Ed%20Sheeran%20-%20Dive.wav`;
const LIBRARY_ID = `local-server:${createHash("sha1").update("Library Song.wav").digest("hex").slice(0, 24)}`;

const stagedSong: PlayerSong = {
  id: "local-server:staged-dive",
  title: "Dive",
  artist: "Ed Sheeran",
  imageUrl: `${STAGED_COVER}?${STALE_AUTH}`,
  audioUrl: `${STAGED_AUDIO}?${STALE_AUTH}`,
  source: "server",
  staged: true,
  preview: true,
  discoverTrackId: "yt:zg95do1LTdk",
};
const librarySong: PlayerSong = {
  id: LIBRARY_ID,
  title: "Library Song",
  artist: "Listener",
  imageUrl: `/api/artwork/local/${encodeURIComponent(LIBRARY_ID)}?spotify_user=${LISTENER_ID}&spotify_scope=user&spotify_exp=1000&spotify_sig=stale`,
  audioUrl: `/api/files/local/Library%20Song.wav?spotify_user=${LISTENER_ID}&spotify_scope=user&spotify_exp=1000&spotify_sig=stale`,
  source: "server",
};

function wav(): Buffer {
  const audio = Buffer.alloc(16044);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

let directory = "";
let origin = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "spotify-stats-home-staged-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  origin = `http://127.0.0.1:${port}`;

  const music = resolve(directory, "music");
  await mkdir(resolve(music, STAGED_DIR), { recursive: true });
  await writeFile(resolve(music, STAGED_DIR, "Ed Sheeran - Dive.wav"), wav());
  await writeFile(resolve(music, STAGED_DIR, "Ed Sheeran - Dive.cover.jpg"), cover);
  const listenerDigest = createHash("sha256").update(LISTENER_ID).digest("hex").slice(0, 32);
  const listenerMusic = resolve(directory, "users", listenerDigest, "music");
  await mkdir(listenerMusic, { recursive: true });
  await writeFile(resolve(listenerMusic, "Library Song.wav"), wav());
  await mkdir(resolve(directory, "cache"));
  await writeFile(resolve(directory, "cache", "discover-staging.json"), JSON.stringify({
    version: 1,
    entries: {
      "yt:zg95do1LTdk": {
        trackId: "yt:zg95do1LTdk", title: "Dive", artist: "Ed Sheeran",
        stagedRelPath: `${STAGED_DIR}/Ed Sheeran - Dive.wav`,
        coverRelPath: `${STAGED_DIR}/Ed Sheeran - Dive.cover.jpg`,
        finalRelPath: "Ed Sheeran - Dive.wav", finalId: stagedSong.id,
        durationMs: 239_000, firstSeenAt: Date.now(), lastSeenAt: Date.now(), lossless: false,
      },
    },
  }));

  server = Bun.spawn([process.execPath, "run", "src/server/local-music-server.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1", PORT: String(port),
      SPOTIFY_MUSIC_DIR: music, SPOTIFY_CACHE_DIR: resolve(directory, "cache"),
      SPOTIFY_LIBRARY_CACHE: resolve(directory, "cache", "library.json"),
      SPOTIFY_ARTWORK_CACHE_DIR: resolve(directory, "artwork"),
      SPOTIFY_USER_MUSIC_DIR: resolve(directory, "users"),
      SPOTIFY_ARTWORK_LOOKUP: "0", SPOTIFY_REQUEST_SIGNING_SECRET: "test-request-secret",
      SPOTIFY_MEDIA_SIGNING_SECRET: "test-media-secret", SPOTIFY_ALLOW_LEGACY_PROXY_TOKEN: "0",
      SPOTIFY_TRUST_LOCAL_NETWORK: "0", SPOTIFY_PROXY_HOSTNAMES: "",
      SPOTIFY_LIBRARY_OWNER_USER_IDS: "", SPOTIFY_LIBRARY_OWNER_EMAILS: "",
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${origin}/api/likes`).catch(() => null);
    if (response?.ok) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("Test music server did not start");
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function homeStats() {
  const sqlite = new Database(":memory:");
  sqlite.exec(D1_SCHEMA_SQL);
  sqlite.run('INSERT INTO "User" (id, email) VALUES (?, ?)', [LISTENER_ID, "listener@example.com"]);
  sqlite.run('INSERT INTO "Session" (id, sessionToken, userId, expires) VALUES (?, ?, ?, ?)', [
    "session", await sha256Hex("test-session"), LISTENER_ID, "2099-01-01",
  ]);
  for (const [index, song] of [librarySong, stagedSong, stagedSong].entries()) {
    sqlite.run(
      'INSERT INTO "PlayEvent" (id, userId, songId, songJson, durationMs, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      [`play-${index}`, LISTENER_ID, song.id, JSON.stringify(song), 60_000, `2026-10-17 15:3${index}:00`],
    );
  }
  const env = {
    MAC_MINI_ORIGIN: origin,
    MAC_MINI_REQUEST_SIGNING_SECRET: "test-request-secret",
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
  try {
    const response = await worker.fetch(new Request("https://music.streamarena.xyz/api/stats/home", {
      headers: { cookie: "spotify_session=test-session" },
    }), env);
    expect(response.status).toBe(200);
    return await response.json() as {
      recentlyPlayed: PlayerSong[];
      mostPlayed: { song: PlayerSong; playCount: number }[];
    };
  } finally {
    sqlite.close();
  }
}

// Caddy sends /api/files/local/* straight to the mini, so the signature alone
// decides which library a phone's image or audio request reads from.
function fetchDirectMedia(url: string) {
  return fetch(`${origin}${url}`, { headers: { host: "music.example" } });
}

function signedFor(url: string) {
  const parsed = new URL(url, "https://music.example");
  return {
    pathname: parsed.pathname,
    user: parsed.searchParams.get("spotify_user"),
    scope: parsed.searchParams.get("spotify_scope"),
    expiresAt: Number(parsed.searchParams.get("spotify_exp")),
  };
}

test("a non-owner's staged song in recentlyPlayed gets fresh, working shared-scope media", async () => {
  expect((await fetchDirectMedia(stagedSong.imageUrl)).status).toBe(401);

  const stats = await homeStats();
  const staged = stats.recentlyPlayed.find((song) => song.id === stagedSong.id)!;
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const url of [staged.imageUrl, staged.audioUrl]) {
    const signed = signedFor(url);
    expect(signed.scope).toBe("shared");
    expect(signed.expiresAt).toBeGreaterThan(nowSeconds);
  }
  expect(signedFor(staged.imageUrl).pathname).toBe(STAGED_COVER);
  expect(signedFor(staged.audioUrl).pathname).toBe(STAGED_AUDIO);
  const { imageUrl: _imageUrl, audioUrl: _audioUrl, ...metadata } = stagedSong;
  expect(staged).toMatchObject(metadata);

  const image = await fetchDirectMedia(staged.imageUrl);
  expect(image.status).toBe(200);
  expect(Buffer.from(await image.arrayBuffer())).toEqual(cover);
  expect((await fetchDirectMedia(staged.audioUrl)).status).toBe(200);

  const top = stats.mostPlayed.find((item) => item.song.id === stagedSong.id)!;
  expect(top.playCount).toBe(2);
  expect(top.song.imageUrl).toBe(staged.imageUrl);
});

test("library songs in the same history keep refreshing in the listener's own scope", async () => {
  const stats = await homeStats();
  const library = stats.recentlyPlayed.find((song) => song.id === LIBRARY_ID)!;
  const signed = signedFor(library.audioUrl);
  expect(signed.user).toBe(LISTENER_ID);
  expect(signed.scope).toBe("user");
  expect(signed.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  expect((await fetchDirectMedia(library.audioUrl)).status).toBe(200);
  expect(signedFor(library.imageUrl)).toMatchObject({ user: LISTENER_ID, scope: "user" });
});
