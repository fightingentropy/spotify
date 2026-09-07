import { afterEach, describe, expect, test } from "bun:test";
import { coercePlaybackState } from "../src/client/playback-state";
import { coercePlayerSongPayload } from "../src/worker/player-payload";
import { refreshPlaybackSong } from "../src/client/playback-recovery";
import { prepareHistorySongForPlayback } from "../src/client/discover-queue";
import { discoverIdentity, mediaLinkExpired } from "../packages/shared/src/playback-source";

const oldSong = {
  id: "local-server:old-preview", title: "Panorama", artist: "TOQUEL", imageUrl: "/cover.jpg",
  audioUrl: "/api/files/local/.discover/yt_iM3f2WKSeWs/Panorama.opus?spotify_exp=1",
};
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; });

describe("saved playback recovery", () => {
  test("old previews recover their identity across both state parsers without losing the resume point", () => {
    const serverSong = coercePlayerSongPayload(oldSong)!;
    const restored = coercePlaybackState({ queue: [serverSong], song: serverSong, currentTime: 83, accountScope: "owner", deviceId: "test" })!;
    expect(restored.currentTime).toBe(83);
    expect(restored.song.youtubeVideoId).toBe("iM3f2WKSeWs");
    expect(restored.song.discoverTrackId).toBe("yt_iM3f2WKSeWs");
    expect(prepareHistorySongForPlayback(restored.song).audioUrl).toBe("");
    expect(coercePlaybackState({ ...restored, song: prepareHistorySongForPlayback(restored.song), queue: [prepareHistorySongForPlayback(restored.song)] })?.song.discoverTrackId).toBe("yt_iM3f2WKSeWs");
  });

  test("expires signed links and does not reinterpret library or arbitrary preview paths", () => {
    expect(mediaLinkExpired(oldSong.audioUrl)).toBe(true);
    expect(mediaLinkExpired("/a?spotify_exp=200", 199_000)).toBe(false);
    expect(mediaLinkExpired("/a")).toBe(false);
    expect(discoverIdentity({}, "/api/files/local/Album/song.opus").discoverTrackId).toBeUndefined();
    expect(discoverIdentity({}, "/other/.discover/yt_iM3f2WKSeWs/song.opus").discoverTrackId).toBeUndefined();
  });

  test("resolves the exact preview again instead of retrying an expired signature", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("/api/discover/stage");
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ ...oldSong, audioUrl: "/fresh.opus" });
    }) as unknown as typeof fetch;
    const fresh = await refreshPlaybackSong(coercePlayerSongPayload(oldSong)!);
    expect(requestBody.youtubeVideoId).toBe("iM3f2WKSeWs");
    expect(fresh.audioUrl).toBe("/fresh.opus");
  });

  test("refreshes library credentials and distinguishes missing files from expired sessions", async () => {
    const song = { ...oldSong, id: "library", audioUrl: "/api/files/local/saved.flac?spotify_exp=1" };
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe("/api/songs/library");
      expect(init?.cache).toBe("no-store");
      return Response.json({ ...song, audioUrl: "/fresh.flac" });
    }) as unknown as typeof fetch;
    expect((await refreshPlaybackSong(song)).audioUrl).toBe("/fresh.flac");
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    await expect(refreshPlaybackSong(song)).rejects.toThrow("Sign in again");
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(refreshPlaybackSong(song)).rejects.toThrow("no longer available");
  });
});
