import { describe, expect, test } from "bun:test";
import { safePodcastUrl } from "../src/lib/podcasts";

describe("podcast URL safety", () => {
  test("allows http and https URLs", () => {
    expect(safePodcastUrl("https://example.com/episode?x=1")).toBe("https://example.com/episode?x=1");
    expect(safePodcastUrl("http://example.com/audio.mp3")).toBe("http://example.com/audio.mp3");
  });

  test("resolves relative URLs against a trusted feed URL", () => {
    expect(safePodcastUrl("/episodes/1", "https://feeds.example.com/podcast/rss")).toBe(
      "https://feeds.example.com/episodes/1",
    );
  });

  test("rejects executable and credentialed URLs", () => {
    expect(safePodcastUrl("javascript:alert(1)", "https://example.com")).toBe("");
    expect(safePodcastUrl("data:text/html,hi", "https://example.com")).toBe("");
    expect(safePodcastUrl("https://user:pass@example.com/audio.mp3")).toBe("");
  });
});
