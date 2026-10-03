export type UserRow = {
  id: string;
  email: string;
  emailVerified: Date | null;
  name: string | null;
  image: string | null;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SongRow = {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  imageUrl: string;
  audioUrl: string;
  lyricsUrl?: string | null;
  duration?: number | null;
  audioBitDepth?: number | null;
  audioSampleRate?: number | null;
  userId: string;
  createdAt: Date;
};

export type PlaylistRow = {
  id: string;
  name: string;
  imageUrl: string | null;
  userId: string;
  createdAt: Date;
};

export type PlaybackStateRow = {
  id: string;
  userId: string;
  deviceId: string | null;
  stateJson: string;
  clientUpdatedAt: number;
  createdAt: Date;
  updatedAt: Date;
};
