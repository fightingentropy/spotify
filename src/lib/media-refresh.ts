import type { PlayerSong } from "../types/player";

export type MediaRefreshItem = Pick<
  PlayerSong,
  "id" | "title" | "artist" | "imageUrl" | "audioUrl" | "lyricsUrl"
>;

const MAX_MEDIA_REFRESH_VALUE_LENGTH = 16_384;

export function normalizeMediaRefreshItem(value: unknown): MediaRefreshItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const artist = typeof item.artist === "string" ? item.artist.trim() : "";
  const imageUrl = typeof item.imageUrl === "string" ? item.imageUrl.trim() : "";
  const audioUrl = typeof item.audioUrl === "string" ? item.audioUrl.trim() : "";
  const lyricsUrl = typeof item.lyricsUrl === "string" ? item.lyricsUrl.trim() : "";
  // Unstaged previews deliberately have no audio URL. Their artwork can still
  // be refreshed, and they must not reject an otherwise valid history batch.
  if (!id || !title || !artist || !imageUrl || typeof item.audioUrl !== "string") return null;
  if (
    id.length > 512 || title.length > 1_024 || artist.length > 1_024 ||
    imageUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH ||
    audioUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH ||
    lyricsUrl.length > MAX_MEDIA_REFRESH_VALUE_LENGTH
  ) return null;
  return { id, title, artist, imageUrl, audioUrl, lyricsUrl: lyricsUrl || undefined };
}
