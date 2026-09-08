import { describe, expect, test } from "bun:test";
import { normalizeMediaRefreshItem } from "../src/lib/media-refresh";
import { mergeRefreshedPlayEventMediaUrls } from "../src/worker/play-events";
import type { PlayerSong } from "../src/types/player";

const librarySong: PlayerSong = {
  id: "library-song", title: "Library track", artist: "Artist",
  imageUrl: "/api/files/local/cover.jpg?spotify_exp=1", audioUrl: "/api/files/local/song.flac",
};

describe("history media refresh", () => {
  test("a preview awaiting audio does not invalidate the library artwork batch", () => {
    const preview: PlayerSong = {
      ...librarySong, id: "preview-song", title: "Preview track", audioUrl: "",
      preview: true, discoverTrackId: "track-id",
    };
    const batch = [librarySong, preview].map(normalizeMediaRefreshItem);
    expect(batch.every(Boolean)).toBe(true);
    expect(batch[1]?.audioUrl).toBe("");
    const refreshed = batch.map((song) => ({ ...song!, imageUrl: "/api/files/local/cover.jpg?spotify_exp=9999999999" }));
    const merged = mergeRefreshedPlayEventMediaUrls([librarySong, preview], refreshed);
    expect(merged.every((song) => song.imageUrl.includes("spotify_exp=9999999999"))).toBe(true);
    expect(merged[1]?.audioUrl).toBe("");
    expect(merged[1]?.discoverTrackId).toBe("track-id");
    expect(merged[1]?.preview).toBe(true);
  });

  test("still rejects malformed or oversized requests", () => {
    for (const audioUrl of [undefined, null, 17, {}]) {
      expect(normalizeMediaRefreshItem({ ...librarySong, audioUrl })).toBeNull();
    }
    expect(normalizeMediaRefreshItem({ ...librarySong, imageUrl: "" })).toBeNull();
    expect(normalizeMediaRefreshItem({ ...librarySong, title: "x".repeat(1_025) })).toBeNull();
    expect(normalizeMediaRefreshItem({ ...librarySong, audioUrl: "x".repeat(16_385) })).toBeNull();
  });
});
