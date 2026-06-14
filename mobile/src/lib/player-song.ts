import type { PlayerSong } from "@/types/player";

// Ported from src/lib/player-song.ts. The kind helpers are pure and port verbatim.
// The web app's OFFLINE_PLAYBACK_SEARCH_PARAM url-rewriting (which made the
// service worker serve cached media) is dropped: in RN, offline tracks carry a
// `file://` audioUrl/imageUrl directly (set by the offline store) and play with
// Range support natively — see §6/§8 of the port brief.

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

export function isOfflinePlaybackSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return song.source === "offline" || song.audioUrl.startsWith("file://");
}
