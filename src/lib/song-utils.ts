import type { SongRow } from "@/lib/db-types";
import type { PlayerSong } from "@/types/player";

export function normalizeMediaUrl(url: string | null | undefined, kind: "image" | "audio"): string {
  if (!url) return "";
  if (url.startsWith("/api/files/")) {
    return url;
  }

  const normalizedKind = kind === "image" ? "images" : "audio";
  const legacyPrefix = kind === "image" ? "/uploads/images/" : "/uploads/audio/";

  if (url.startsWith(legacyPrefix)) {
    const filename = url.slice(legacyPrefix.length);
    return `/api/files/${normalizedKind}/${encodeURIComponent(filename)}`.replace(/%2F/g, "/");
  }

  return url;
}

export function songToPlayerSong(song: SongRow): PlayerSong {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    imageUrl: normalizeMediaUrl(song.imageUrl, "image"),
    audioUrl: normalizeMediaUrl(song.audioUrl, "audio"),
  };
}
