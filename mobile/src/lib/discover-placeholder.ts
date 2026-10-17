import type { PlayerSong } from "@/types/player";

// A queue entry that still needs staging before it can play. Returns a plain
// boolean (not a `song is PlayerSong` predicate): callers always gate on
// `song && isUnstagedDiscoverSong(song)`, and a predicate would wrongly narrow
// `song` to `never` in the code after an early `return` in that branch.
export function isUnstagedDiscoverSong(song: PlayerSong | null | undefined): boolean {
  return Boolean(song && song.discoverTrackId && !song.audioUrl);
}
