import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import { SongGrid } from "@/components/SongGrid";
import { songToPlayerSong } from "@/lib/song-utils";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { PlaylistRow, SongRow } from "@/lib/db-types";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const playlists = await (db`
    SELECT "id", "name", "imageUrl", "userId", "createdAt"
    FROM "Playlist"
    WHERE "id" = ${id}
    LIMIT 1
  ` as any) as PlaylistRow[];
  const playlist = playlists.at(0);
  if (!playlist) return notFound();

  const songRows = await (db`
    SELECT s."id", s."title", s."artist", s."imageUrl", s."audioUrl", s."userId", s."createdAt", ps."order"
    FROM "PlaylistSong" ps
    INNER JOIN "Song" s ON s."id" = ps."songId"
    WHERE ps."playlistId" = ${id}
    ORDER BY ps."order" ASC
  ` as any) as (SongRow & { order: number })[];

  const songs = songRows.map((row) => songToPlayerSong(row));
  const songIds = songRows.map((row) => row.id);
  let likedSongIds: string[] = [];
  if (userId && songIds.length > 0) {
    const rows = await (db`
      SELECT "songId"
      FROM "Like"
      WHERE "userId" = ${userId}
    ` as any) as { songId: string }[];
    const likedSet = new Set(rows.map((like) => like.songId));
    likedSongIds = songIds.filter((songId) => likedSet.has(songId));
  }

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-1">{playlist.name}</h1>
      <div className="text-sm opacity-70 mb-6">{songs.length} tracks</div>
      {songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid songs={songs} likedSongIds={likedSongIds} canLike={!!userId} />
      )}
      <div className="h-24" />
    </div>
  );
}
