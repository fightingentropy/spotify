export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  // Set by offline resolution when imageUrl is swapped for a device-local file:
  // the original remote cover URL, used as a render fallback if the local copy
  // is corrupt or missing — and, crucially, handed to the lock-screen now-playing
  // center, which cannot read file:// covers (see §11). Never persisted to
  // play-event snapshots.
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
