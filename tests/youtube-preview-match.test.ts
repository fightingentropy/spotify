import { describe, expect, test } from "bun:test";
import {
  passesArtistGate,
  pickBestYouTubeMatch,
  scoreYouTubeCandidate,
  type YouTubeSearchEntry,
} from "../src/server/youtube-preview";

// The Smart Shuffle YouTube-preview matcher must be "confident-match-or-nothing":
// it stages a rec's audio only when artist AND (Spotify-known) duration line up.
// These fixtures pin the failure modes found during live validation.

describe("passesArtistGate", () => {
  test("rejects results where the artist never appears (ambiguous title word)", () => {
    // Real failure: searching "Marsh Vetiver" surfaced vetiver-GRASS farming videos.
    const entry: YouTubeSearchEntry = {
      id: "x",
      title: "Why Vetiver Hedgerows are Superior for Soil",
      uploader: "Vetiver Grass - TVNI Webinar",
      duration: 73,
    };
    expect(passesArtistGate({ artist: "Marsh" }, entry)).toBe(false);
  });

  test("accepts a Topic art-track whose channel carries the artist", () => {
    const entry: YouTubeSearchEntry = {
      id: "y",
      title: "Carry Me Higher",
      uploader: "Real Deep - Topic",
      duration: 189,
    };
    expect(passesArtistGate({ artist: "Real Deep" }, entry)).toBe(true);
  });

  test("an empty artist never gates anything out", () => {
    expect(passesArtistGate({ artist: "" }, { id: "z", title: "anything" })).toBe(true);
  });
});

describe("pickBestYouTubeMatch", () => {
  test("returns null when no candidate clears the artist gate", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "a", title: "Why Vetiver Hedgerows are Superior", uploader: "Vetiver Grass - TVNI", duration: 73 },
      { id: "b", title: "Vetiver Grass - A Climate Smart Plant", uploader: "Vetiver Grass - TVNI", duration: 261 },
    ];
    const match = pickBestYouTubeMatch({ title: "Vetiver", artist: "Marsh", durationMs: 230_000 }, entries, 0.5);
    expect(match).toBeNull();
  });

  test("prefers the artist's Topic art-track over a same-title track by a different artist", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "topic", title: "Carry Me Higher", uploader: "Real Deep - Topic", duration: 189 },
      { id: "other", title: "Carry Me Higher (7 Inch Version)", uploader: "The Blessed Madonna", duration: 271 },
    ];
    const match = pickBestYouTubeMatch({ title: "Carry Me Higher", artist: "Real Deep", durationMs: 188_000 }, entries, 0.5);
    expect(match?.videoId).toBe("topic");
  });

  test("duration kills an hour-long Full Album upload that otherwise matches", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "song", title: "Lane 8 - Brightest Lights feat. POLIÇA", uploader: "This Never Happened", duration: 413 },
      { id: "album", title: "Lane 8 - Brightest Lights (Full Album Continuous Mix)", uploader: "This Never Happened", duration: 3549 },
    ];
    const match = pickBestYouTubeMatch({ title: "Brightest Lights", artist: "Lane 8", durationMs: 413_000 }, entries, 0.5);
    expect(match?.videoId).toBe("song");
  });

  test("studio version outranks a live version when the rec isn't 'live'", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "studio", title: "RÜFÜS DU SOL - Innerbloom (Official Video)", uploader: "RÜFÜS DU SOL", duration: 579 },
      { id: "live", title: "RÜFÜS DU SOL - Innerbloom (Live at Red Rocks)", uploader: "RÜFÜS DU SOL", duration: 600 },
    ];
    const opts = { title: "Innerbloom", artist: "RÜFÜS DU SOL", durationMs: 579_000 };
    expect(scoreYouTubeCandidate(opts, entries[0])).toBeGreaterThan(scoreYouTubeCandidate(opts, entries[1]));
    expect(pickBestYouTubeMatch(opts, entries, 0.5)?.videoId).toBe("studio");
  });

  test("accented and case-folded artist/title still match", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "ok", title: "Ben Böhmer - Breathing", uploader: "Anjunadeep", duration: 223 },
    ];
    const match = pickBestYouTubeMatch({ title: "Breathing", artist: "Ben Bohmer", durationMs: 223_000 }, entries, 0.5);
    expect(match?.videoId).toBe("ok");
  });
});
