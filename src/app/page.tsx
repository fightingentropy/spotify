import { getServerSession } from "next-auth";
import { SongGrid } from "@/components/SongGrid";
import { HomeSearchCommandPalette } from "@/components/HomeSearchCommandPalette";
import { songToPlayerSong } from "@/lib/song-utils";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function Home() {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  const [songs, liked] = await Promise.all([
    (db`
      SELECT "id", "title", "artist", "imageUrl", "audioUrl", "lyricsUrl", "audioBitDepth", "audioSampleRate", "userId", "createdAt"
      FROM "Song"
      ORDER BY "title" ASC
    ` as any) as Promise<SongRow[]>,
    userId
      ? (db`
          SELECT "songId"
          FROM "Like"
          WHERE "userId" = ${userId}
        ` as any) as Promise<{ songId: string }[]>
      : Promise.resolve([] as Array<{ songId: string }>),
  ]);

  const likedSongIds = liked.map((l) => l.songId);
  const playerSongs = songs.map(songToPlayerSong);

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <HomeSearchCommandPalette songs={playerSongs} />
      {playerSongs.length === 0 ? (
        <div className="opacity-70">No songs available yet. Upload your first track to get started.</div>
      ) : (
        <SongGrid songs={playerSongs} likedSongIds={likedSongIds} canLike={!!userId} />
      )}
      <div className="h-24" />
    </div>
  );
}
