export type PlayerSong = {
  id: string;
  // Content-canonical id: shared by every physical copy of the same song (files
  // that share an inode) so one logical song can be referenced from many
  // playlists and liked once. Equals `id` for the anchor copy; only collapsed
  // duplicate copies have a canonicalId that differs from their id.
  canonicalId?: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  // The original remote cover URL, used as a render fallback when imageUrl fails
  // to load. Never persisted to play-event snapshots.
  networkImageUrl?: string;
  audioUrl: string;
  lyricsUrl?: string;
  description?: string;
  link?: string;
  createdAt?: string;
  duration?: number;
  audioBitDepth?: number;
  audioSampleRate?: number;
  source?: "server" | "browser-local" | "picked-file" | "radio" | "podcast" | "offline";
  localPath?: string;
  writable?: boolean;
  // A Discover "Top 50" track playing from the hidden .discover staging cache: it
  // is NOT in the library. Any "keep" action (like / add-to-playlist / download)
  // first promotes it into the real library via /api/discover/promote.
  // discoverTrackId is the Spotify track id used for that promote call.
  staged?: boolean;
  discoverTrackId?: string;
  // A YouTube Music mix track: stages its preview Opus directly by this videoId
  // (no title/artist search). Marks the queue entry for cheap preview staging.
  youtubeVideoId?: string;
};
