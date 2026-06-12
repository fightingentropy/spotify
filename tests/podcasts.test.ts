import { describe, expect, test } from "bun:test";
import {
  extractPodcastFeedMediaUrls,
  podcastFeedAllowsMediaUrl,
  podcastMediaProxyUrl,
  safePodcastUrl,
  type PodcastShow,
} from "../src/lib/podcasts";

const show: PodcastShow = {
  id: "test-show",
  title: "Test Show",
  author: "Tester",
  subtitle: "",
  description: "",
  feedUrl: "https://feeds.example.com/podcast/rss",
  websiteUrl: "https://example.com",
  imageUrl: "https://images.example.com/cover.jpg",
  accentClassName: "",
};

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

describe("podcast media proxy URLs", () => {
  test("builds a same-origin proxy URL with the media URL encoded", () => {
    expect(podcastMediaProxyUrl("test-show", "https://cdn.example.com/ep.mp3?updated=1&b=2")).toBe(
      "/api/podcast-media/test-show?url=https%3A%2F%2Fcdn.example.com%2Fep.mp3%3Fupdated%3D1%26b%3D2",
    );
  });
});

describe("podcast feed media URL extraction", () => {
  const feedXml = `<?xml version="1.0"?>
    <rss><channel>
      <title>Test Show</title>
      <image><url>https://images.example.com/channel.png</url></image>
      <itunes:image href="https://images.example.com/itunes.jpg?w=300&amp;h=300"/>
      <item>
        <title>Episode 1</title>
        <enclosure url="https://cdn.example.com/ep1.mp3?updated=111&amp;via=feed" type="audio/mpeg"/>
      </item>
      <item>
        <title>Episode 2</title>
        <enclosure url='/episodes/ep2.mp3' type="audio/mpeg"/>
        <link>javascript:alert(1)</link>
        <itunes:image href="javascript:alert(2)"/>
      </item>
    </channel></rss>`;

  test("collects enclosure, image, and show cover URLs with XML entities decoded", () => {
    const urls = extractPodcastFeedMediaUrls(feedXml, show);
    expect(urls.has("https://cdn.example.com/ep1.mp3?updated=111&via=feed")).toBe(true);
    expect(urls.has("https://images.example.com/itunes.jpg?w=300&h=300")).toBe(true);
    expect(urls.has("https://images.example.com/channel.png")).toBe(true);
    expect(urls.has("https://feeds.example.com/episodes/ep2.mp3")).toBe(true);
    expect(urls.has(show.imageUrl)).toBe(true);
  });

  test("never collects non-http URLs", () => {
    const urls = extractPodcastFeedMediaUrls(feedXml, show);
    for (const url of urls) expect(url.startsWith("http")).toBe(true);
  });

  test("membership check tolerates tracking-param drift but not other URLs", () => {
    const urls = extractPodcastFeedMediaUrls(feedXml, show);
    expect(podcastFeedAllowsMediaUrl(urls, "https://cdn.example.com/ep1.mp3?updated=111&via=feed")).toBe(true);
    expect(podcastFeedAllowsMediaUrl(urls, "https://cdn.example.com/ep1.mp3?updated=222")).toBe(true);
    expect(podcastFeedAllowsMediaUrl(urls, "https://cdn.example.com/other.mp3")).toBe(false);
    expect(podcastFeedAllowsMediaUrl(urls, "https://evil.example.net/ep1.mp3")).toBe(false);
    expect(podcastFeedAllowsMediaUrl(urls, "not a url")).toBe(false);
  });
});
