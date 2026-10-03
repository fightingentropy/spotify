import type { OfflineDownloadRecord } from "./offline-download-queue";
import type { PlayerSong } from "../types/player";

// The server's catalog can disappear independently of the device's library.
// Retain the user's explicit liked downloads, never incidental playback caches
// or another account's files. Confirmed unlikes override these recovery pins.
export function downloadedLikedSongs(
  records: Record<string, OfflineDownloadRecord>,
  accountScope: string,
  unlikedIds: readonly string[] = [],
  canonicalOf: (id: string) => string = (id) => id,
): PlayerSong[] {
  if (!accountScope || accountScope === "anonymous") return [];
  const excluded = new Set(unlikedIds.map(canonicalOf));
  return Object.values(records)
    .filter((record) =>
      record.accountScope === accountScope &&
      record.status === "ready" && Boolean(record.audioPath) &&
      record.scopes.includes("liked") && !excluded.has(canonicalOf(record.songId)),
    )
    .map((record) => record.song);
}

export function mergeDownloadedLikes(
  remote: readonly PlayerSong[],
  downloaded: readonly PlayerSong[],
  likedIds: Record<string, true>,
  canonicalOf: (id: string) => string = (id) => id,
): PlayerSong[] {
  const songs = [...remote];
  const seen = new Set(remote.map((song) => canonicalOf(song.id)));
  for (const song of downloaded) {
    const id = canonicalOf(song.id);
    if (seen.has(id) || (!likedIds[song.id] && !likedIds[id])) continue;
    seen.add(id);
    songs.push(song);
  }
  return songs;
}
