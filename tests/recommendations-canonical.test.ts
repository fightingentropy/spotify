import { describe, expect, test } from "bun:test";
import { looksNonCanonicalTrack } from "../src/lib/song-dedupe";
import {
  bestSearchCandidate,
  type SearchCandidate,
  type SpotifyBatchTrack,
} from "../src/lib/spotify-pathfinder";

describe("looksNonCanonicalTrack", () => {
  test("flags the cover-farm tracks seen in the wild", () => {
    expect(looksNonCanonicalTrack("BAD IDEA, Right? (R.R.C1)", "Ravens Rock")).toBe(true);
    expect(looksNonCanonicalTrack("HELL YEAH - RAVEN Ruin sessions", "Ravens Rock")).toBe(true);
  });

  test("flags karaoke / version / edit markers", () => {
    expect(looksNonCanonicalTrack("Flowers (Karaoke Version)", "Sing King")).toBe(true);
    expect(looksNonCanonicalTrack("Hello (In the Style of Adele)", "Karaoke Crew")).toBe(true);
    expect(looksNonCanonicalTrack("As It Was (Made Famous by Harry Styles)", "Studio Group")).toBe(true);
    expect(looksNonCanonicalTrack("Shape of You (Acoustic Cover)", "Some Duo")).toBe(true);
    expect(looksNonCanonicalTrack("Smells Like Teen Spirit (Lullaby Version)", "Rockabye Baby!")).toBe(true);
    expect(looksNonCanonicalTrack("Levitating - 8 Bit", "8 Bit Universe")).toBe(true);
    expect(looksNonCanonicalTrack("Blinding Lights (Nightcore)", "NCS")).toBe(true);
    expect(looksNonCanonicalTrack("Anti-Hero (Sped Up)", "Edit Lab")).toBe(true);
    expect(looksNonCanonicalTrack("Bad Guy (Cover Version)", "Cover Band")).toBe(true);
  });

  test("flags short code-like version tags (letter + digit/dot)", () => {
    expect(looksNonCanonicalTrack("Yesterday (V2)", "Whoever")).toBe(true);
    expect(looksNonCanonicalTrack("Some Song [X-3]", "Whoever")).toBe(true);
  });

  test("does NOT flag canonical titles that merely contain a marker word", () => {
    expect(looksNonCanonicalTrack("Blinding Lights", "The Weeknd")).toBe(false);
    expect(looksNonCanonicalTrack("bad idea right?", "Olivia Rodrigo")).toBe(false);
    expect(looksNonCanonicalTrack("Tribute", "Tenacious D")).toBe(false);
    expect(looksNonCanonicalTrack("Karaoke", "Drake")).toBe(false);
    expect(looksNonCanonicalTrack("Lullaby", "The Cure")).toBe(false);
    expect(looksNonCanonicalTrack("Ringtone", "100 gecs")).toBe(false);
    expect(looksNonCanonicalTrack("Cover Me", "Bruce Springsteen")).toBe(false);
  });

  test("does NOT flag legit parentheticals (reprise / year / part)", () => {
    expect(looksNonCanonicalTrack("(I Can't Get No) Satisfaction", "The Rolling Stones")).toBe(false);
    expect(looksNonCanonicalTrack("Hey Jude (Reprise)", "The Beatles")).toBe(false);
    expect(looksNonCanonicalTrack("Free Bird (1990)", "Lynyrd Skynyrd")).toBe(false);
    expect(looksNonCanonicalTrack("The Suite (Pt. 2)", "Some Band")).toBe(false);
    expect(looksNonCanonicalTrack("Bohemian Rhapsody - Remastered 2011", "Queen")).toBe(false);
  });
});

describe("bestSearchCandidate", () => {
  const query = (name: string, ...artists: string[]): SpotifyBatchTrack => ({ id: "", name, artists });
  const cand = (id: string, name: string, ...artists: string[]): SearchCandidate => ({ id, name, artists });

  test("prefers an exact-artist match over a loose multi-artist overlap", () => {
    const candidates = [
      cand("loose", "Forever", "Chris Brown", "Drake", "Kanye West", "Lil Wayne"),
      cand("exact", "Forever", "Drake"),
    ];
    expect(bestSearchCandidate(candidates, query("Forever", "Drake"))?.id).toBe("exact");
  });

  test("rejects a junk/cover candidate when a clean track was requested", () => {
    const junkOnly = [cand("junk", "Hello", "Adele Karaoke Version")];
    expect(bestSearchCandidate(junkOnly, query("Hello", "Adele"))).toBeNull();

    const withClean = [cand("junk", "Hello", "Adele Karaoke Version"), cand("real", "Hello", "Adele")];
    expect(bestSearchCandidate(withClean, query("Hello", "Adele"))?.id).toBe("real");
  });

  test("requires title equality and artist overlap (guards wrong-track)", () => {
    expect(bestSearchCandidate([cand("x", "Bar", "Adele")], query("Foo", "Adele"))).toBeNull();
    expect(bestSearchCandidate([cand("x", "Hello", "Lionel Richie")], query("Hello", "Adele"))).toBeNull();
  });

  test("returns the canonical match for a clean query", () => {
    const candidates = [cand("a", "Levitating", "Dua Lipa")];
    expect(bestSearchCandidate(candidates, query("Levitating", "Dua Lipa"))?.id).toBe("a");
  });
});
