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
  test("rejects capacitor:// audio URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "capacitor://localhost/api/files/local/test.flac" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "CAPACITOR://localhost/test.flac" }))).toBe(true);
  });

  test("rejects file: and _capacitor_file_ URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "file:///var/mobile/Containers/test.flac" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "https://localhost/_capacitor_file_/var/mobile/test.flac" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "/_capacitor_file_/var/mobile/test.flac" }))).toBe(true);
  });

  test("rejects URLs carrying the offline-playback marker", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "/api/files/local/test.flac?spotify_offline=1" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "https://example.com/api/files/local/test.flac?spotify_offline=1" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ imageUrl: "/api/files/local/cover.jpg?x=1&spotify_offline=1" }))).toBe(true);
  });

  test("rejects blob: image URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ imageUrl: "blob:https://localhost/abc-123" }))).toBe(true);
  });

  test("rejects device-local lyrics URLs when present", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "capacitor://localhost/lyrics.lrc" }))).toBe(true);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "/api/lyrics/test.lrc?spotify_offline=1" }))).toBe(true);
  });

  test("accepts relative /api URLs and absolute http(s) URLs", () => {
    expect(playEventSongHasDeviceLocalUrl(makeSong())).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "https://example.com/api/files/local/test.flac" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "http://example.com/test.mp3", imageUrl: "https://example.com/cover.jpg" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ lyricsUrl: "/api/lyrics/test.lrc" }))).toBe(false);
    expect(playEventSongHasDeviceLocalUrl(makeSong({ audioUrl: "/api/files/local/test.flac?codec=flac" }))).toBe(false);
  });
});
