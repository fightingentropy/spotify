import { db } from "@/lib/db";

let songLyricsColumnEnsured = false;

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
