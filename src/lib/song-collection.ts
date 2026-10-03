import { normalizeLibrarySearchQuery, songMatchesLibraryQuery } from "@spotify/shared/library-search";
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

// A library is reused across keystrokes, sort changes and like updates. Avoid
// Unicode normalization for every field on every keystroke; WeakMap entries are
// released with the song objects when the collection/account is replaced.
const searchFields = new WeakMap<PlayerSong, {
  title: string;
  artist: string;
  album: string | undefined;
  normalized: string[];
}>();

function normalizedSearchFields(song: PlayerSong): string[] {
  const cached = searchFields.get(song);
  if (cached && cached.title === song.title && cached.artist === song.artist && cached.album === song.album) {
    return cached.normalized;
  }
  const normalized = [song.title, song.artist, song.album ?? ""].map(normalizeLibrarySearchQuery);
  searchFields.set(song, { title: song.title, artist: song.artist, album: song.album, normalized });
  return normalized;
}

function compareText(left: string | undefined, right: string | undefined): number {
  const a = left?.trim() ?? "";
  const b = right?.trim() ?? "";
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return collator.compare(a, b);
}

export function sortCollectionSongs(songs: readonly PlayerSong[], mode: SongSortMode): PlayerSong[] {
  // Parsing in the comparator does O(n log n) date conversions. Build these once
  // per sort, including invalid/missing dates, without changing tie ordering.
  const dates = mode === "uploaded_desc" || mode === "uploaded_asc"
    ? new Map(songs.map((song) => [song, Date.parse(song.createdAt ?? "") || 0]))
    : null;
  const sorted = mode === "default" ? songs : [...songs].sort((left, right) => {
    if (mode === "uploaded_desc" || mode === "uploaded_asc") {
      const a = dates!.get(left)!;
      const b = dates!.get(right)!;
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
  const normalized = normalizeLibrarySearchQuery(query);
  if (!normalized) return [...songs];
  const tokens = normalized.split(/\s+/);
  const directMatches = songs.filter((song) => {
    const fields = normalizedSearchFields(song);
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  });
  // A collection is also a playable selection: "Blur" must not queue "Blue"
  // tracks alongside the band. Recover spelling only when direct matches fail.
  if (directMatches.length > 0) return directMatches;
  return songs.filter((song) => songMatchesLibraryQuery({
    title: song.title,
    artist: [song.artist, song.album].filter(Boolean).join(" "),
  }, query));
}
