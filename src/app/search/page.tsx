import MobileSearch from "@/components/MobileSearch";
import { songToPlayerSong } from "@/lib/song-utils";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";

export const revalidate = 0;

export default async function SearchPage() {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();

  const songs = await db<SongRow>`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
    FROM "Song"
    ORDER BY "title" ASC
    LIMIT 5000
  `;

  const playerSongs = songs.map(songToPlayerSong);

  return (
    <>
      <div className="lg:hidden">
        <MobileSearch songs={playerSongs} />
      </div>
      <div className="hidden lg:block px-6 py-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6">Search</h1>
        <MobileSearch songs={playerSongs} />
      </div>
      <div className="h-24 lg:hidden" />
    </>
  );
}
