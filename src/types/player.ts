export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  // Set by offline resolution when imageUrl is swapped for a device-local file:
  // the original remote cover URL, used as a render fallback if the local copy
  // is corrupt or missing. Never persisted to play-event snapshots.
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
};
