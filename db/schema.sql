-- Schema definition derived from the former Prisma migration.
-- Apply with: psql $DATABASE_URL -f db/schema.sql

CREATE TABLE IF NOT EXISTS "public"."User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_provider_providerAccountId_key" UNIQUE ("provider", "providerAccountId")
);

CREATE TABLE IF NOT EXISTS "public"."Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL UNIQUE,
    "userId" TEXT NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "expires" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "expires" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VerificationToken_identifier_token_key" UNIQUE ("identifier", "token")
);

CREATE TABLE IF NOT EXISTS "public"."Song" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "audioUrl" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "public"."Playlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "userId" TEXT NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "public"."PlaylistSong" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playlistId" TEXT NOT NULL REFERENCES "public"."Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "songId" TEXT NOT NULL REFERENCES "public"."Song"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PlaylistSong_playlistId_songId_key" UNIQUE ("playlistId", "songId")
);

CREATE TABLE IF NOT EXISTS "public"."Like" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "songId" TEXT NOT NULL REFERENCES "public"."Song"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Like_userId_songId_key" UNIQUE ("userId", "songId")
);
