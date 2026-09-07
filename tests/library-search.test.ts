import { describe, expect, test } from "bun:test";
import {
  escapeLikePattern,
  normalizeLibrarySearchQuery,
  songMatchesLibraryQuery,
  rankLibrarySongs,
} from "../packages/shared/src/library-search";

describe("library search query matching", () => {
  test("matches title or artist case-insensitively", () => {
    const song = { title: "Helix", artist: "Justice" };
    expect(songMatchesLibraryQuery(song, "hel")).toBe(true);
    expect(songMatchesLibraryQuery(song, "JUST")).toBe(true);
    expect(songMatchesLibraryQuery(song, "nope")).toBe(false);
  });

  test("an empty query matches every song", () => {
    expect(songMatchesLibraryQuery({ title: "A", artist: "B" }, "   ")).toBe(true);
  });

  test("matches title and artist in either order, including punctuation and accents", () => {
    const song = { title: "Song 2", artist: "Blur" };
    expect(songMatchesLibraryQuery(song, "Song 2 Blur")).toBe(true);
    expect(songMatchesLibraryQuery(song, "Blur song 2")).toBe(true);
    expect(songMatchesLibraryQuery({ title: "Déjà Vu", artist: "Beyoncé" }, "beyonce deja-vu")).toBe(true);
  });

  test("allows one typo in a long word without fuzzing short names or unrelated terms", () => {
    const song = { title: "Superstition", artist: "Stevie Wonder" };
    for (const query of ["Superstiton", "Superstitoin", "Stevie Wondre", "superstitiom"]) {
      expect(songMatchesLibraryQuery(song, query)).toBe(true);
    }
    expect(songMatchesLibraryQuery(song, "Stevie Blunder")).toBe(false);
    expect(songMatchesLibraryQuery({ title: "Song 2", artist: "Blur" }, "Song 3")).toBe(false);
  });

  test("ranks the exact recording before variants and typo suggestions", () => {
    const songs = [
      { title: "Song 2 live", artist: "Blur" },
      { title: "Snog 2", artist: "Blur" },
      { title: "Song 2", artist: "Blur" },
    ];
    expect(rankLibrarySongs(songs, "Song 2 Blur")).toEqual([songs[2], songs[0], songs[1]]);
  });

  test("escapes LIKE wildcards in user input", () => {
    expect(escapeLikePattern("100%_real\\x")).toBe("100\\%\\_real\\\\x");
    expect(normalizeLibrarySearchQuery("  Helix  ")).toBe("helix");
  });
});
