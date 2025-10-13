#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { db } from "../src/lib/db";

async function ensureDemoUser(email: string, password: string) {
  const passwordHash = await hash(password, 10);
  const [row] =
    await db<{ id: string }>`
      INSERT INTO "User" ("id", "email", "name", "passwordHash", "image", "emailVerified", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${email}, 'Demo User', ${passwordHash}, NULL, NULL, NOW(), NOW())
      ON CONFLICT ("email") DO UPDATE
      SET "updatedAt" = NOW(), "passwordHash" = EXCLUDED."passwordHash"
      RETURNING "id"
    `;
  return row.id;
}

async function ensureSongs(userId: string) {
  const songs = [
    {
      title: "Sample Track 3s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-1.jpg",
      audioUrl: "/uploads/audio/sample-3s.mp3",
    },
    {
      title: "Sample Track 6s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-2.jpg",
      audioUrl: "/uploads/audio/sample-6s.mp3",
    },
    {
      title: "Sample Track 12s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-3.jpg",
      audioUrl: "/uploads/audio/sample-12s.mp3",
    },
    {
      title: "SoundHelix Song 1",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-1.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-1.mp3",
    },
    {
      title: "SoundHelix Song 2",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-2.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-2.mp3",
    },
    {
      title: "SoundHelix Song 3",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-3.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-3.mp3",
    },
  ];

  for (const song of songs) {
    const existing =
      await db<{ id: string }>`
        SELECT "id"
        FROM "Song"
        WHERE "audioUrl" = ${song.audioUrl}
        LIMIT 1
      `;
    if (existing.length === 0) {
      await db`
        INSERT INTO "Song" ("id", "title", "artist", "imageUrl", "audioUrl", "userId")
        VALUES (${randomUUID()}, ${song.title}, ${song.artist}, ${song.imageUrl}, ${song.audioUrl}, ${userId})
      `;
    }
  }
}

async function main() {
  const userId = await ensureDemoUser("demo@example.com", "password");
  await ensureSongs(userId);
  console.log("Database seeded");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
