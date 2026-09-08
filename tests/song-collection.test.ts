import { describe, expect, test } from "bun:test";
import { filterCollectionSongs, isSongSortMode, sortCollectionSongs } from "../src/lib/song-collection";
import type { PlayerSong } from "../src/types/player";

function song(id: string, title: string, artist: string, album?: string, createdAt?: string): PlayerSong {
  return { id, title, artist, album, createdAt, imageUrl: "/cover.jpg", audioUrl: "/audio.flac" };
}
const songs = [
  song("ten", "Song 10", "Blur", "Blur", "2026-09-07"),
  song("two", "Song 2", "Blur", "Blur", "2026-09-08"),
  song("wonder", "Superstition", "Stevie Wonder", "Talking Book"),
  song("accent", "Déjà Vu", "Beyoncé"),
];

describe("collection browsing", () => {
  test("filters across title, artist and album with accents and spelling tolerance", () => {
    expect(filterCollectionSongs(songs, "song 2 blur").map((s) => s.id)).toEqual(["two"]);
    expect(filterCollectionSongs(songs, "superstiton stevie").map((s) => s.id)).toEqual(["wonder"]);
    expect(filterCollectionSongs(songs, "talking book").map((s) => s.id)).toEqual(["wonder"]);
    expect(filterCollectionSongs(songs, "deja beyonce").map((s) => s.id)).toEqual(["accent"]);
    expect(filterCollectionSongs(songs, "unrelated")).toEqual([]);
  });

  test("filtering preserves the selected order and never changes the source collection", () => {
    const original = songs.slice();
    const sorted = sortCollectionSongs(songs, "title");
    expect(filterCollectionSongs(sorted, "blur").map((s) => s.id)).toEqual(["two", "ten"]);
    expect(songs).toEqual(original);
    expect(filterCollectionSongs(songs, "  ")).toEqual(songs);
  });

  test("sorts titles naturally and artists using titles as a tiebreaker", () => {
    expect(sortCollectionSongs(songs, "title").map((s) => s.id)).toEqual(["accent", "two", "ten", "wonder"]);
    expect(sortCollectionSongs(songs, "artist").map((s) => s.id)).toEqual(["accent", "two", "ten", "wonder"]);
    expect(sortCollectionSongs(songs, "album").map((s) => s.id)).toEqual(["two", "ten", "wonder", "accent"]);
  });

  test("retains default and date orders, deduplicates ids, and handles missing dates", () => {
    expect(sortCollectionSongs([...songs, songs[0]!], "default")).toEqual(songs);
    expect(sortCollectionSongs(songs, "uploaded_desc").map((s) => s.id)).toEqual(["two", "ten", "wonder", "accent"]);
    expect(sortCollectionSongs(songs, "uploaded_asc").map((s) => s.id)).toEqual(["wonder", "accent", "ten", "two"]);
    expect(isSongSortMode("album")).toBe(true);
    expect(isSongSortMode("uploaded_desc")).toBe(true);
    expect(isSongSortMode("unknown")).toBe(false);
    expect(isSongSortMode(null)).toBe(false);
  });
});
