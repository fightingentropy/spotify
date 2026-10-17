import { describe, expect, test } from "bun:test";
import { isAwaitingAudio, songPlaybackState } from "../src/lib/playback-loading";
import type { PlayerSong } from "../src/types/player";

function song(id: string, options: { discoverTrackId?: string; audioUrl?: string } = {}): PlayerSong {
  return {
    id,
    title: "Song",
    artist: "Artist",
    imageUrl: "",
    audioUrl: options.audioUrl ?? `/audio/${id}`,
    discoverTrackId: options.discoverTrackId,
  };
}

describe("playback loading", () => {
  const placeholder = song("discover:yt:abc", { discoverTrackId: "yt:abc", audioUrl: "" });
  const staged = song("local-server:123", { discoverTrackId: "yt:abc" });

  test("a playing placeholder is loading until its source is staged", () => {
    expect(isAwaitingAudio({ currentSong: placeholder, isPlaying: true }, null)).toBe(true);
    expect(isAwaitingAudio({ currentSong: staged, isPlaying: true }, null)).toBe(false);
  });

  test("the engine's buffering song is loading only while play is requested", () => {
    expect(isAwaitingAudio({ currentSong: staged, isPlaying: true }, staged.id)).toBe(true);
    expect(isAwaitingAudio({ currentSong: staged, isPlaying: false }, staged.id)).toBe(false);
    expect(isAwaitingAudio({ currentSong: placeholder, isPlaying: false }, null)).toBe(false);
  });

  test("a stale buffering id from the previous song does not mark the new one", () => {
    expect(isAwaitingAudio({ currentSong: staged, isPlaying: true }, "local-server:old")).toBe(false);
  });

  test("rows follow the placeholder through its staged id swap", () => {
    expect(songPlaybackState({ currentSong: placeholder, isPlaying: true }, placeholder, null)).toBe("loading");
    expect(songPlaybackState({ currentSong: staged, isPlaying: true }, placeholder, null)).toBe("playing");
    expect(songPlaybackState({ currentSong: staged, isPlaying: false }, placeholder, null)).toBe("paused");
    expect(songPlaybackState({ currentSong: staged, isPlaying: true }, song("other"), null)).toBe("idle");
  });
});
