export type PlayerSong = {
  id: string;
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
};
