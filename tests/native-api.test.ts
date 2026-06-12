import { describe, expect, test } from "bun:test";
import { NATIVE_API_ORIGIN, rewriteNativeApiUrl, shouldRewriteNativeApiUrl } from "../src/lib/native-api";

describe("native API URL rewriting", () => {
  test("rewrites ordinary API requests to the remote origin", () => {
    expect(rewriteNativeApiUrl("/api/library?auth=user-1", "https://localhost/")).toBe(
      `${NATIVE_API_ORIGIN}/api/library?auth=user-1`,
    );
    expect(shouldRewriteNativeApiUrl("/api/home", "https://localhost/")).toBe(true);
  });

  test("rewrites absolute capacitor-origin API URLs (download pump resolveUrl output)", () => {
    expect(rewriteNativeApiUrl("capacitor://localhost/api/files/audio/song.flac")).toBe(
      `${NATIVE_API_ORIGIN}/api/files/audio/song.flac`,
    );
    expect(rewriteNativeApiUrl("capacitor://localhost/api/podcast-media/show?url=https%3A%2F%2Fcdn.example.com%2Fep.mp3")).toBe(
      `${NATIVE_API_ORIGIN}/api/podcast-media/show?url=https%3A%2F%2Fcdn.example.com%2Fep.mp3`,
    );
  });

  test("keeps local and offline-preferred media URLs local", () => {
    expect(rewriteNativeApiUrl("capacitor://localhost/_capacitor_file_/song.flac")).toBe(
      "capacitor://localhost/_capacitor_file_/song.flac",
    );
    expect(rewriteNativeApiUrl("/api/files/song.flac?spotify_offline=1", "https://localhost/")).toBe(
      "/api/files/song.flac?spotify_offline=1",
    );
    expect(shouldRewriteNativeApiUrl("/api/files/song.flac?spotify_offline=1", "https://localhost/")).toBe(false);
  });
});
