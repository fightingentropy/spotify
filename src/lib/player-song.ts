import type { PlayerSong } from "@/types/player";

export function isRadioSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return song.source === "radio" || song.id.startsWith("radio:");
}

export function isPodcastSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return song.source === "podcast" || song.id.startsWith("podcast:");
}

export type SongKind = "podcast" | "radio" | "music";

// The "kind" of a queue item. Everything that isn't a podcast or a radio
// station is treated as music. setQueue keeps a queue to a single kind so
// advancing through music never lands on a podcast (and vice-versa).
export function songKind(song: PlayerSong | null | undefined): SongKind {
  if (isPodcastSong(song)) return "podcast";
  if (isRadioSong(song)) return "radio";
  return "music";
}

