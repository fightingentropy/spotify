import type { DiscoverTrack } from "@/client/api";
import type { PlayerSong } from "@/types/player";

// Player-queue support for curated playlists. Their tracks play read-through
// like Discover — nothing is written to the library. A track that's already
// staged becomes a fully playable queue entry; one that isn't becomes a
// PLACEHOLDER (empty audioUrl) carrying the metadata the stager needs to
// materialize it on demand when it becomes the current track. See
// DiscoverQueueStager, which drives that just-in-time staging + prefetch.

export const DISCOVER_PLACEHOLDER_PREFIX = "discover:";

export function discoverTrackToPlayerSong(track: DiscoverTrack): PlayerSong {
  const duration = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
  // Already staged: a real, instantly-playable song (stable library id `audioId`).
  if (track.staged && track.audioUrl && track.audioId) {
    return {
      id: track.audioId,
      title: track.title,
      artist: track.artist,
      album: track.album || undefined,
      imageUrl: track.imageUrl,
      audioUrl: track.audioUrl,
      duration,
      source: "server",
      staged: true,
      discoverTrackId: track.id,
    };
  }
  // Not staged: a placeholder. The empty audioUrl marks it for the stager and
  // keeps the player idle (rather than erroring) until the real source lands.
  return {
    id: `${DISCOVER_PLACEHOLDER_PREFIX}${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    imageUrl: track.imageUrl,
    audioUrl: "",
    duration,
    source: "server",
    discoverTrackId: track.id,
  };
}

// A queue entry that still needs staging before it can play.
export function isUnstagedDiscoverSong(song: PlayerSong | null | undefined): song is PlayerSong {
  return Boolean(song && song.discoverTrackId && !song.audioUrl);
}

// Materialize an un-staged curated track into a playable song via the same
// on-demand endpoint the Discover row uses. The response carries a real
// audioUrl + stable id and keeps `discoverTrackId` (so the now-playing
// highlight survives the swap). Throws on failure.
export async function stageDiscoverSong(song: PlayerSong): Promise<PlayerSong> {
  const trackId = song.discoverTrackId;
  if (!trackId) throw new Error("Not a discover track");
  const res = await fetch("/api/discover/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      region: "US",
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationMs: song.duration ? Math.round(song.duration * 1000) : undefined,
      imageUrl: song.imageUrl,
      qualityProfile: "max",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Couldn't load this track (${res.status})`);
  }
  return (await res.json()) as PlayerSong;
}
