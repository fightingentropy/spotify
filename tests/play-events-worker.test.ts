import { describe, expect, test } from "bun:test";
import { playEventSongHasDeviceLocalUrl } from "../src/worker/index";
import type { PlayerSong } from "../src/types/player";

function makeSong(overrides: Partial<PlayerSong> = {}): Pick<PlayerSong, "audioUrl" | "imageUrl" | "lyricsUrl"> {
  return {
    audioUrl: "/api/files/local/test.flac",
    imageUrl: "/apple-icon.png",
    ...overrides,
  };
}

describe("playEventSongHasDeviceLocalUrl", () => {
  // Offline downloads and the native Capacitor wrapper were removed, so the only
  // device-local scheme the web app still produces is blob: (browser-local
  // uploads), which the server can't fetch and must not record a play event for.
  test("rejects blob: URLs in any media field", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "blob:https://localhost/abc-123" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ imageUrl: "blob:https://localhost/abc-123" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "blob:https://localhost/lyr-1" }))).toBe(true);
  });

  test("accepts relative /api URLs and absolute http(s) URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong())).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "https://example.com/api/files/local/test.flac" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "http://example.com/test.mp3", imageUrl: "https://example.com/cover.jpg" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "/api/lyrics/test.lrc" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "/api/files/local/test.flac?codec=flac" }))).toBe(false);
  });
});
