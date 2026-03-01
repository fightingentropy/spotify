import { getServerSession } from "next-auth";
import { SongGrid } from "@/components/SongGrid";
import { songToPlayerSong } from "@/lib/song-utils";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function LikedPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  if (!userId) {
    return (
      <div className="px-6 py-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
        <div className="opacity-70">
          <a className="underline" href="/signin">
            Sign in
          </a>{" "}
          to view and manage your liked songs.
        </div>
      </div>
    );
  }

  const rows = await (db`
    SELECT s."id", s."title", s."artist", s."imageUrl", s."audioUrl", s."lyricsUrl", s."userId", s."createdAt", l."songId"
    FROM "Like" l
    INNER JOIN "Song" s ON s."id" = l."songId"
    WHERE l."userId" = ${userId}
    ORDER BY l."createdAt" DESC
  ` as any) as (SongRow & { songId: string })[];

  const songs = rows.map((row) => songToPlayerSong(row));
  const likedSongIds = rows.map((row) => row.songId);

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
      {songs.length === 0 ? (
        <div className="opacity-70">You haven&apos;t liked any songs yet.</div>
      ) : (
        <SongGrid
          songs={songs}
          likedSongIds={likedSongIds}
          hideIfUnliked
          canLike
          emptyLabel="You haven&apos;t liked any songs yet."
          viewToggleClassName="-mt-14 mb-8"
        />
      )}
      <div className="h-24" />
    </div>
  );
}
