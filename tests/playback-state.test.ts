import { describe, expect, test } from "bun:test";
import { coercePlaybackState } from "../src/client/playback-state";

describe("playback state sync", () => {
  test("preserves podcast playback metadata", () => {
    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [
        {
          id: "podcast:show:episode",
          title: "Episode",
          artist: "Show",
          imageUrl: "/cover.jpg",
          audioUrl: "https://example.com/episode.mp3",
          source: "podcast",
          description: "A useful description",
          link: "https://example.com/show-notes",
          duration: 123,
        },
      ],
      currentIndex: 0,
      currentTime: 42,
      isPlaying: true,
      updatedAt: 99,
      deviceId: "device-1",
    });

    expect(state?.song.description).toBe("A useful description");
    expect(state?.song.link).toBe("https://example.com/show-notes");
    expect(state?.currentTime).toBe(42);
    expect(state?.updatedAt).toBe(99);
  });

  test("rejects non-portable browser-local playback state", () => {
    const state = coercePlaybackState({
      accountScope: "user-1",
      queue: [
        {
          id: "browser-local:episode",
          title: "Local",
          artist: "Files",
          imageUrl: "/cover.jpg",
          audioUrl: "blob:http://localhost/audio",
          source: "browser-local",
        },
      ],
      currentIndex: 0,
      currentTime: 42,
      isPlaying: false,
    });

    expect(state).toBeNull();
  });
});
