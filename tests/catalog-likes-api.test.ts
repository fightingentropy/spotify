import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("catalog likes survive API reloads and a server restart without downloaded audio", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "spotify-catalog-api-test-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const music = resolve(directory, "music");
  await mkdir(music);
  const trackId = "40EB7ABUO6MoWMUwPKptJ7";
  // A tiny PCM fixture makes the file-move/scan test independent of ffmpeg.
  // The manifest flags model ordinary and approved YouTube staging copies.
  const audio = Buffer.alloc(16044);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  await mkdir(resolve(music, ".discover", "fallback"), { recursive: true });
  await writeFile(resolve(music, ".discover", "fallback", "song.wav"), audio);
  const entry = {
    trackId, title: "Let It Go", artist: "James Bay", lossless: false,
    stagedRelPath: ".discover/fallback/song.wav", finalRelPath: "James Bay - Let It Go.wav",
    finalId: "local-server:preview", firstSeenAt: Date.now(), lastSeenAt: Date.now(),
  };
  await mkdir(resolve(directory, "cache"));
  await writeFile(resolve(directory, "cache", "discover-staging.json"), JSON.stringify({
    version: 1, entries: {
      [trackId]: entry,
      "yt:GsPq9mzFNGY": { ...entry, trackId: "yt:GsPq9mzFNGY", libraryFallback: true },
    },
  }));
  const start = () => Bun.spawn([process.execPath, "run", "src/server/local-music-server.ts"], {
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
    },
    stdout: "ignore", stderr: "ignore",
  });
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${origin}/api/likes`).catch(() => null);
      if (response?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Test music server did not start");
  };
  let server = start();
  try {
    await ready();
    const response = await fetch(`${origin}/api/likes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ songId: "local-server:preview", song: {
        id: "local-server:preview", discoverTrackId: "40EB7ABUO6MoWMUwPKptJ7",
        title: "Let It Go", artist: "James Bay", audioUrl: "/expired-preview.opus",
      } }),
    });
    expect(response.status).toBe(200);
    const saved = await response.json() as { song: { id: string }; likedSongIds: string[] };
    expect(saved.song.id).toBe("catalog:40EB7ABUO6MoWMUwPKptJ7");
    expect(saved.likedSongIds).toContain(saved.song.id);

    server.kill();
    await server.exited;
    server = start();
    await ready();
    const liked = await (await fetch(`${origin}/api/liked`)).json();
    expect(liked.likedSongIds).toEqual([saved.song.id]);
    expect(liked.songs).toHaveLength(1);
    expect(liked.songs[0].title).toBe("Let It Go");
    expect(liked.songs[0].audioUrl).toBe("");
    expect(liked.songs[0].discoverTrackId).toBe("40EB7ABUO6MoWMUwPKptJ7");
    expect((await (await fetch(`${origin}/api/home`)).json()).likedSongIds).toContain(saved.song.id);

    const promote = (id: string, finalId?: string) => fetch(`${origin}/api/discover/promote`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trackId: id, finalId }),
    });
    expect((await promote(trackId)).status).toBe(409);
    const promoted = await promote("yt:GsPq9mzFNGY");
    expect(promoted.status).toBe(200);
    const downloaded = await promoted.json();
    expect(downloaded.audioUrl).not.toContain(".discover");
    expect(downloaded.audioUrl).toContain(".wav");
    expect(await readFile(resolve(music, entry.finalRelPath))).toEqual(audio);
    expect((await promote("yt:GsPq9mzFNGY", downloaded.id)).status).toBe(200);
    const fileLike = await fetch(`${origin}/api/likes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ songId: downloaded.id }),
    });
    expect(fileLike.status).toBe(200);
    const downloadedLikes = await (await fetch(`${origin}/api/liked`)).json();
    expect(downloadedLikes.songs).toHaveLength(1);
    expect(downloadedLikes.likedSongIds).not.toContain(saved.song.id);
    expect(downloadedLikes.songs[0].id).toBe(downloaded.id);

    const removed = await fetch(`${origin}/api/likes`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ songId: downloaded.id }),
    });
    expect(removed.status).toBe(200);
    expect((await (await fetch(`${origin}/api/liked`)).json()).songs).toEqual([]);
    expect((await (await fetch(`${origin}/api/likes`)).json()).likedSongIds).toEqual([]);
  } finally {
    server.kill();
    await server.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
