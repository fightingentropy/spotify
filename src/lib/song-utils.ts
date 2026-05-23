import type { SongRow } from "@/lib/db-types";
import type { PlayerSong } from "@/types/player";

const LEGACY_WAVEFORM_COVER = "/waveform.svg";
const SPOTIFY_FALLBACK_COVER = "/apple-icon.png";

export function normalizeCoverImageUrl(url: string | null | undefined): string {
  if (!url || url === LEGACY_WAVEFORM_COVER) return SPOTIFY_FALLBACK_COVER;
  return url;
}

export function normalizeMediaUrl(
  url: string | null | undefined,
  kind: "image" | "audio" | "lyrics",
): string {
  if (!url) return "";
  if (kind === "image" && url === LEGACY_WAVEFORM_COVER) {
    return SPOTIFY_FALLBACK_COVER;
  }
  if (url.startsWith("/api/files/")) {
    const encoded = url.slice("/api/files/".length);
    let decoded = encoded;
    for (let i = 0; i < 2; i++) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      } catch {
        break;
      }
    }
    return `/api/files/${decoded}`;
  }

  const normalizedKind =
    kind === "image" ? "images" : kind === "audio" ? "audio" : "lyrics";
  const legacyPrefix =
    kind === "image"
      ? "/uploads/images/"
      : kind === "audio"
        ? "/uploads/audio/"
        : "/uploads/lyrics/";

  if (url.startsWith(legacyPrefix)) {
    const filename = url.slice(legacyPrefix.length);
    return `/api/files/${normalizedKind}/${encodeURIComponent(filename)}`.replace(/%2F/g, "/");
  }

  return url;
}

export function songToPlayerSong(song: SongRow): PlayerSong {
  const createdDate =
    song.createdAt instanceof Date ? song.createdAt : new Date(String(song.createdAt));
  const createdAtIso = Number.isFinite(createdDate.getTime())
    ? createdDate.toISOString()
    : undefined;
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    imageUrl: normalizeMediaUrl(song.imageUrl, "image"),
    audioUrl: normalizeMediaUrl(song.audioUrl, "audio"),
    lyricsUrl: normalizeMediaUrl(song.lyricsUrl, "lyrics"),
    createdAt: createdAtIso,
    audioBitDepth:
      typeof song.audioBitDepth === "number" ? song.audioBitDepth : undefined,
    audioSampleRate:
      typeof song.audioSampleRate === "number" ? song.audioSampleRate : undefined,
  };
}
