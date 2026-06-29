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
  // A YouTube Music mix track: stages its preview Opus directly by this videoId
  // (no title/artist search). Marks the queue entry for cheap preview staging.
  youtubeVideoId?: string;
  // A catalog search result that isn't in the library: stage a cheap YouTube Opus
  // PREVIEW on play (resolver-independent) rather than the full lossless source.
  // A "keep" action (like / add-to-playlist) still promotes it to lossless FLAC.
  preview?: boolean;
  // Initial-insert sugar marking a Smart Shuffle recommendation interleaved into
  // the queue. Authoritative rec-membership lives in the player store's in-memory
  // `recommendedIds` Set (the id changes on staging, which would drop this flag),
  // so this is only a convenience on the freshly-built PlayerSong before insert.
  recommended?: boolean;
  // ISO timestamp of WHEN this song was liked (set only on /api/liked responses).
  // Lets the "Date added" sort mean recently-liked, not the FLAC's file date.
  // Absent for legacy likes / everywhere else → those fall back to createdAt.
  likedAt?: string;
};
