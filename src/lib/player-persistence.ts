import { isBrowserLocalSong } from "@/lib/browser-local-song";
import { isRadioSong } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

export function isPersistablePlayerSong(song: PlayerSong | null | undefined): song is PlayerSong {
  return Boolean(song && !isBrowserLocalSong(song) && !isRadioSong(song));
}
