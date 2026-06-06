import { describe, expect, test } from "bun:test";
import { isPersistablePlayerSong } from "../src/lib/player-persistence";
import type { PlayerSong } from "../src/types/player";

function song(overrides: Partial<PlayerSong> = {}): PlayerSong {
  return {
    id: "server:1",
    title: "Track",
    artist: "Artist",
    imageUrl: "https://example.com/cover.jpg",
    audioUrl: "https://example.com/audio.mp3",
    ...overrides,
  };
}

describe("player persistence", () => {
  test("persists replayable remote sources and podcast episodes", () => {
    expect(isPersistablePlayerSong(song())).toBe(true);
    expect(isPersistablePlayerSong(song({ source: "offline" }))).toBe(true);
    expect(
      isPersistablePlayerSong(
        song({
          id: "podcast:flagrant:episode-1",
          source: "podcast",
          title: "Flagrant episode",
        }),
      ),
    ).toBe(true);
  });

  test("does not persist live streams or browser-local files", () => {
    expect(isPersistablePlayerSong(song({ id: "radio:bbc-radio-1", source: "radio" }))).toBe(false);
    expect(isPersistablePlayerSong(song({ id: "browser-local:track", source: "browser-local" }))).toBe(false);
    expect(isPersistablePlayerSong(song({ id: "picked-file:track", source: "picked-file" }))).toBe(false);
    expect(isPersistablePlayerSong(song({ audioUrl: "blob:https://example.com/123" }))).toBe(false);
  });
});
