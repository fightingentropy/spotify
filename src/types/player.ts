export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  imageUrl: string;
  audioUrl: string;
  lyricsUrl?: string;
  createdAt?: string;
  audioBitDepth?: number;
  audioSampleRate?: number;
};
