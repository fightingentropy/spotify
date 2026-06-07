import {
  fetchSpotifyAlbumTracks,
  fetchSpotifyLikedTracks,
  fetchSpotifyPlaylistTracks,
  type SpotifyBatchTrack,
} from "@/lib/spotify-pathfinder";

export type ClientBatchInfo = {
  type: "track" | "album" | "playlist";
  title: string;
  artist: string;
  trackCount: number;
  format: "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";
  trackIds: string[];
  tracks: ClientBatchTrack[];
};

export type ClientBatchTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

function parsePlaylistId(input: string): string | null {
  const match = input.match(/playlist\/([A-Za-z0-9]{22})/);
  return match?.[1] ?? null;
}

function parseAlbumId(input: string): string | null {
  const match = input.match(/album\/([A-Za-z0-9]{22})/);
  return match?.[1] ?? null;
}

function isCollectionUrl(input: string): boolean {
  return input.includes("/collection/");
}

export async function resolveSpotifyBatchOnClient(
  spotifyUrl: string,
  spotifyCookie: string,
  format: ClientBatchInfo["format"] = "flac",
): Promise<ClientBatchInfo> {
  const url = spotifyUrl.trim();
  const cookie = spotifyCookie.trim();

  if (isCollectionUrl(url)) {
    if (!cookie) {
      throw new Error("Liked Songs import requires a Spotify sp_dc cookie.");
    }
    const liked = await fetchSpotifyLikedTracks(cookie);
    return batchFromTracks("playlist", liked.title, "Various Artists", liked.tracks, format);
  }

  const playlistId = parsePlaylistId(url);
  if (playlistId) {
    const playlist = await fetchSpotifyPlaylistTracks(playlistId, cookie || undefined);
    return batchFromTracks("playlist", playlist.title, "Various Artists", playlist.tracks, format);
  }

  const albumId = parseAlbumId(url);
  if (albumId) {
    const album = await fetchSpotifyAlbumTracks(albumId, cookie || undefined);
    return batchFromTracks("album", album.title, album.artist, album.tracks, format);
  }

  throw new Error("Paste a Spotify playlist, album, or Liked Songs URL.");
}

function batchFromTracks(
  type: ClientBatchInfo["type"],
  title: string,
  artist: string,
  tracks: SpotifyBatchTrack[],
  format: ClientBatchInfo["format"],
): ClientBatchInfo {
  const seen = new Set<string>();
  const batchTracks: ClientBatchTrack[] = [];
  for (const track of tracks) {
    if (!track.id || seen.has(track.id)) continue;
    seen.add(track.id);
    batchTracks.push({
      spotifyId: track.id,
      title: track.name || "Unknown Track",
      artist: track.artists.filter(Boolean).join(", ") || "Unknown Artist",
      album: track.album || "",
      releaseDate: track.releaseDate || "",
      totalPlays: 0,
      durationMs: track.durationMs || 0,
      imageUrl: track.imageUrl || "",
      previewUrl: "",
    });
  }
  if (batchTracks.length === 0) {
    throw new Error("No tracks found in that Spotify library.");
  }
  return {
    type,
    title,
    artist,
    trackCount: batchTracks.length,
    format,
    trackIds: batchTracks.map((track) => track.spotifyId),
    tracks: batchTracks,
  };
}
