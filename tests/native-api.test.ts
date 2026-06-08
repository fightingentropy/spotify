import { describe, expect, test } from "bun:test";
import { NATIVE_API_ORIGIN, rewriteNativeApiUrl, shouldRewriteNativeApiUrl } from "../src/lib/native-api";

describe("native API URL rewriting", () => {
  test("rewrites ordinary API requests to the remote origin", () => {
    expect(rewriteNativeApiUrl("/api/library?auth=user-1", "https://localhost/")).toBe(
      `${NATIVE_API_ORIGIN}/api/library?auth=user-1`,
    );
    expect(shouldRewriteNativeApiUrl("/api/home", "https://localhost/")).toBe(true);
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
