import type { PlayerSong } from "@/types/player";

/**
 * Normalizes a song title/artist for dedupe comparison: trims, lowercases, and
 * collapses internal whitespace runs to a single space.
 */
export function normalizeSongPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Dedupes songs that share the same normalized title + artist, keeping the most
 * recently created entry. Uses Number.isFinite guards so an unparseable
 * createdAt (NaN) is treated as the oldest timestamp instead of corrupting the
 * comparison.
 */
export function dedupeSongsByTitleArtist(songs: PlayerSong[]): PlayerSong[] {
  const unique = new Map<string, PlayerSong>();
  for (const song of songs) {
    const key = `${normalizeSongPart(song.title)}::${normalizeSongPart(song.artist)}`;
    const current = unique.get(key);
    if (!current) {
      unique.set(key, song);
      continue;
    }
    const currentTime = Date.parse(current.createdAt || "");
    const nextTime = Date.parse(song.createdAt || "");
    const a = Number.isFinite(currentTime) ? currentTime : 0;
    const b = Number.isFinite(nextTime) ? nextTime : 0;
    if (b >= a) {
      unique.set(key, song);
    }
  }
  return [...unique.values()];
}
