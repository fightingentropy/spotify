import type { AddTrack } from "react-native-track-player";
import { toAbsoluteApiUrl } from "@/lib/config";
import { isRadioSong } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

// Lock-screen / Control-Center artwork MUST be a remote http(s) URL — the native
// now-playing center can't read file:// or data: covers (§11). For offline tracks
// we hand RNTP `networkImageUrl` (the original remote cover), not the local file.
export function lockScreenArtwork(song: PlayerSong): string | undefined {
  const candidate = song.networkImageUrl || song.imageUrl;
  if (!candidate) return undefined;
  const resolved = toAbsoluteApiUrl(candidate);
  if (/^(file|data|blob):/i.test(resolved)) return undefined;
  return resolved;
}

// Convert a PlayerSong into an RNTP track. The signed audioUrl is passed VERBATIM
// (only the origin is prepended for relative URLs) — re-encoding or stripping the
// signature returns 403 and the track silently fails (§1).
export function buildTrack(song: PlayerSong): AddTrack {
  return {
    id: song.id,
    url: toAbsoluteApiUrl(song.audioUrl),
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: lockScreenArtwork(song),
    duration: song.duration,
    isLiveStream: isRadioSong(song),
  };
}
