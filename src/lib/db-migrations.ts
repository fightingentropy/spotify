import { db } from "@/lib/db";

let songLyricsColumnEnsured = false;
let songAudioColumnsEnsured = false;

export async function ensureSongLyricsColumn(): Promise<void> {
  if (songLyricsColumnEnsured) {
    return;
  }

  try {
    await db`
      ALTER TABLE "Song"
      ADD COLUMN "lyricsUrl" TEXT
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }

  songLyricsColumnEnsured = true;
}

export async function ensureSongAudioColumns(): Promise<void> {
  if (songAudioColumnsEnsured) {
    return;
  }

  // Keep raw SQL for SQLite compatibility; db tag does not parameterize identifiers.
  try {
    await db`ALTER TABLE "Song" ADD COLUMN "audioBitDepth" INTEGER`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }

  try {
    await db`ALTER TABLE "Song" ADD COLUMN "audioSampleRate" INTEGER`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }

  songAudioColumnsEnsured = true;
}
