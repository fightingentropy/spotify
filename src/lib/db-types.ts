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

export type AccountRow = {
  id: string;
  userId: string;
  type: string;
  provider: string;
  providerAccountId: string;
  refresh_token: string | null;
  access_token: string | null;
  expires_at: number | null;
  token_type: string | null;
  scope: string | null;
  id_token: string | null;
  session_state: string | null;
};

export type SessionRow = {
  id: string;
  sessionToken: string;
  userId: string;
  expires: Date;
};

export type VerificationTokenRow = {
  identifier: string;
  token: string;
  expires: Date;
};

export type SongRow = {
  id: string;
  title: string;
  artist: string;
  imageUrl: string;
  audioUrl: string;
  lyricsUrl?: string | null;
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

export type PlaylistSongRow = {
  id: string;
  playlistId: string;
  songId: string;
  order: number;
};

export type LikeRow = {
  id: string;
  userId: string;
  songId: string;
  createdAt: Date;
};
