import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import { SongGrid } from "@/components/SongGrid";
import { songToPlayerSong } from "@/lib/song-utils";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { PlaylistRow, SongRow } from "@/lib/db-types";
import { ensureSongAudioColumns, ensureSongLyricsColumn } from "@/lib/db-migrations";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureSongLyricsColumn();
  await ensureSongAudioColumns();
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const playlists = await db<PlaylistRow>`
    SELECT "id", "name", "imageUrl", "userId", "createdAt"
    FROM "Playlist"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  const playlist = playlists.at(0);
  if (!playlist) return notFound();

  const songRows = await db<SongRow & { order: number; likedSongId: string | null }>`
    SELECT
      s."id",
      s."title",
      s."artist",
      s."imageUrl",
      s."audioUrl",
      s."lyricsUrl",
      s."audioBitDepth",
      s."audioSampleRate",
      s."userId",
      s."createdAt",
      ps."order",
      l."songId" AS "likedSongId"
    FROM "PlaylistSong" ps
    INNER JOIN "Song" s ON s."id" = ps."songId"
    LEFT JOIN "Like" l
      ON l."songId" = s."id"
      AND l."userId" = ${userId ?? ""}
    WHERE ps."playlistId" = ${id}
    ORDER BY ps."order" ASC
  `;

  const songs = songRows.map((row) => songToPlayerSong(row));
  const likedSongIds = userId
    ? songRows.filter((row) => !!row.likedSongId).map((row) => row.id)
    : [];

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-1">{playlist.name}</h1>
      <div className="text-sm opacity-70 mb-6">{songs.length} tracks</div>
      {songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid
          songs={songs}
          likedSongIds={likedSongIds}
          canLike={!!userId}
          viewToggleClassName="-mt-14 mb-8"
        />
      )}
      <div className="h-24" />
    </div>
  );
}
