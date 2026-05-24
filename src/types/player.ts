export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  imageUrl: string;
  audioUrl: string;
  lyricsUrl?: string;
  createdAt?: string;
  duration?: number;
  audioBitDepth?: number;
  audioSampleRate?: number;
  source?: "server" | "browser-local" | "picked-file";
  localPath?: string;
  writable?: boolean;
};
