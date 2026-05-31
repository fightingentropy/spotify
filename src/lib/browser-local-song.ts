import type { PlayerSong } from "@/types/player";

export function isBrowserLocalSong(song: PlayerSong | null | undefined): boolean {
  if (!song) return false;
  return (
    song.source === "browser-local" ||
    song.source === "picked-file" ||
    song.id.startsWith("browser-local:") ||
    song.id.startsWith("picked-file:") ||
    song.audioUrl.startsWith("blob:")
  );
}
