import { songMatchesLibraryQuery } from "@spotify/shared/library-search";
import type { PlayerSong } from "@/types/player";

export const SONG_SORT_OPTIONS = [
  { value: "default", label: "Default order" },
  { value: "title", label: "Title (A–Z)" },
  { value: "artist", label: "Artist (A–Z)" },
  { value: "album", label: "Album (A–Z)" },
  { value: "uploaded_desc", label: "Upload date (newest)" },
  { value: "uploaded_asc", label: "Upload date (oldest)" },
] as const;

export type SongSortMode = (typeof SONG_SORT_OPTIONS)[number]["value"];

export function isSongSortMode(value: unknown): value is SongSortMode {
  return SONG_SORT_OPTIONS.some((option) => option.value === value);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareText(left: string | undefined, right: string | undefined): number {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return collator.compare(a, b);
}

export function sortCollectionSongs(songs: readonly PlayerSong[], mode: SongSortMode): PlayerSong[] {
  const sorted = mode === "default" ? songs : [...songs].sort((left, right) => {
    if (mode === "uploaded_desc" || mode === "uploaded_asc") {
      const a = Date.parse(left.createdAt ?? "") || 0;
      const b = Date.parse(right.createdAt ?? "") || 0;
      return mode === "uploaded_desc" ? b - a : a - b;
    }
    return compareText(left[mode], right[mode]) ||
      compareText(left.artist, right.artist) || compareText(left.title, right.title);
  });
  const seen = new Set<string>();
  return sorted.filter((song) => {
    if (seen.has(song.id)) return false;
    seen.add(song.id);
    return true;
  });
}

export function filterCollectionSongs(songs: readonly PlayerSong[], query: string): PlayerSong[] {
  return songs.filter((song) => songMatchesLibraryQuery({
    title: song.title,
    artist: [song.artist, song.album].filter(Boolean).join(" "),
  }, query));
}
