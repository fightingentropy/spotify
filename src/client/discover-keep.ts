import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// "Keeping" a staged Discover track — liking it, adding it to a playlist, or
// downloading it — first promotes it out of the Mac-mini's hidden .discover
// staging cache into the real library (so it scans and can be liked/owned).
// Promotion returns the now-real song (stable id, library audioUrl); we swap it
// into the player queue so subsequent loads use the library copy. Returns the
// promoted song, the original song if it wasn't staged, or null if promotion
// failed (callers should abort the keep action in that case).
export async function promoteStagedSong(song: PlayerSong): Promise<PlayerSong | null> {
  if (!song.discoverTrackId) return song;
  try {
    const res = await fetch("/api/discover/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      // finalId lets the server stay idempotent: if this track was already
      // promoted (no longer staged), it returns the existing library song.
      body: JSON.stringify({ trackId: song.discoverTrackId, finalId: song.id }),
    });
    if (!res.ok) return null;
    const promoted = (await res.json()) as PlayerSong;
    if (!promoted?.id || !promoted.audioUrl) return null;
    usePlayerStore.getState().replaceStagedSong(song.id, promoted);
    return promoted;
  } catch {
    return null;
  }
}
