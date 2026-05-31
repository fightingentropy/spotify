import type { PlayerSong } from "@/types/player";

export const OFFLINE_PLAYBACK_SEARCH_PARAM = "spotify_offline";

export function isRadioSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return song.source === "radio" || song.id.startsWith("radio:");
}

function urlBase(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://localhost";
}

export function preferOfflinePlaybackUrl(value: string): string {
  if (!value || /^(blob:|data:)/i.test(value)) return value;
  try {
    const isAbsolute = /^https?:\/\//i.test(value);
    const url = new URL(value, urlBase());
    url.searchParams.set(OFFLINE_PLAYBACK_SEARCH_PARAM, "1");
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

export function isOfflinePlaybackSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  if (song.source === "offline") return true;
  try {
    const url = new URL(song.audioUrl, urlBase());
    return url.searchParams.get(OFFLINE_PLAYBACK_SEARCH_PARAM) === "1";
  } catch {
    return false;
  }
}

export function preferOfflinePlaybackSong(song: PlayerSong): PlayerSong {
  return {
    ...song,
    source: "offline",
    audioUrl: preferOfflinePlaybackUrl(song.audioUrl),
    imageUrl: preferOfflinePlaybackUrl(song.imageUrl),
    lyricsUrl: song.lyricsUrl ? preferOfflinePlaybackUrl(song.lyricsUrl) : undefined,
  };
}
