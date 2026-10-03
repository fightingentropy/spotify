import { describe, expect, test } from "bun:test";
import { fetchLrclibLyrics, lyricsCompleteness, simplifiedLyricsTitle } from "../src/lib/download-lyrics";

const full = "[00:01.00]First line\n[00:30.00]Second line\n[01:00.00]Third line\n[01:50.00]Fourth line";
const plain = "First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line";
const record = (lyrics: string, extra: Record<string, unknown> = {}) => ({ trackName: "Example", artistName: "Artist", duration: 120, syncedLyrics: lyrics, ...extra });
function fake(handler: (url: URL) => unknown) {
  return async (input: string) => Response.json(handler(new URL(input)));
}
describe("download lyrics fallback", () => {
  test("prefers complete lyrics over a truncated synchronized excerpt", () => {
    expect(lyricsCompleteness(full, 120_000).complete).toBe(true);
    expect(lyricsCompleteness("[00:01.00]Only one line", 120_000).complete).toBe(false);
    expect(lyricsCompleteness(plain).score).toBeGreaterThan(lyricsCompleteness("[00:01.00]Only one line").score);
  });
  test("continues search past incomplete exact results and rejects a different recording", async () => {
    const found = await fetchLrclibLyrics("Example", "Artist", { durationMs: 120_000 }, fake(url =>
      url.pathname.endsWith("/get") ? record("[00:01.00]Excerpt") : [record(full, { duration: 300 }), record(full)]));
    expect(found).toBe(full);
  });
  test("keeps the title fallback optional and verifies duration on artist mismatches", async () => {
    const calls: string[] = [];
    const fetcher = fake(url => {
      calls.push(url.href);
      return url.searchParams.has("artist_name") ? [] : [record(full, { artistName: "Another name" })];
    });
    expect(await fetchLrclibLyrics("Example", "Artist", { titleFallback: false, durationMs: 120_000 }, fetcher)).toBe("");
    expect(calls.every(url => new URL(url).searchParams.has("artist_name"))).toBe(true);
    expect(await fetchLrclibLyrics("Example", "Artist", { titleFallback: true, durationMs: 120_000 }, fetcher)).toBe(full);
    expect(await fetchLrclibLyrics("Example", "Artist", { titleFallback: true }, fetcher)).toBe("");
  });
  test("simplifies release suffixes and prefers complete plain lyrics to partial timed lines", async () => {
    expect(simplifiedLyricsTitle("Example (feat. Guest) - 2025 Remaster")).toBe("Example");
    const found = await fetchLrclibLyrics("Example - 2025 Remaster", "Artist", { durationMs: 120_000 }, fake(url =>
      url.searchParams.get("track_name") === "Example" ? record("[00:01.00]Excerpt", { plainLyrics: plain }) : []));
    expect(found).toBe(plain);
  });
  test("bounds external bodies and ignores malformed replies", async () => {
    const huge = async () => new Response(" ".repeat(1024 * 1024 + 1));
    expect(await fetchLrclibLyrics("Example", "Artist", { titleFallback: false }, huge)).toBe("");
    expect(await fetchLrclibLyrics("Example", "Artist", { titleFallback: false }, fake(() => ({ bad: true })))).toBe("");
  });
});
