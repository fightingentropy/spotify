import type { SongRow } from "@/lib/db-types";
import { rewriteNativeApiUrl } from "@/lib/native-api";
import type { PlayerSong } from "@/types/player";

const SPOTIFY_FALLBACK_COVER = "/apple-icon.png";

function isNativeCapacitorApp(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  try {
    return !!capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

export function resolveNativeApiUrl(url: string): string {
  return isNativeCapacitorApp() ? rewriteNativeApiUrl(url) : url;
}

export function normalizeCoverImageUrl(url: string | null | undefined): string {
  if (!url) return SPOTIFY_FALLBACK_COVER;
  return resolveNativeApiUrl(url);
}

export function normalizeMediaUrl(
  url: string | null | undefined,
  _kind: "image" | "audio" | "lyrics",
): string {
  if (!url) return "";
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
    album: typeof song.album === "string" && song.album.trim() ? song.album.trim() : undefined,
    imageUrl: normalizeMediaUrl(song.imageUrl, "image"),
    audioUrl: normalizeMediaUrl(song.audioUrl, "audio"),
    lyricsUrl: normalizeMediaUrl(song.lyricsUrl, "lyrics"),
    createdAt: createdAtIso,
    duration:
      typeof song.duration === "number" && Number.isFinite(song.duration)
        ? song.duration
        : undefined,
    audioBitDepth:
      typeof song.audioBitDepth === "number" ? song.audioBitDepth : undefined,
    audioSampleRate:
      typeof song.audioSampleRate === "number" ? song.audioSampleRate : undefined,
  };
}
