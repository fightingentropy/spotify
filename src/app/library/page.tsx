import Link from "next/link";
import { getServerSession } from "next-auth";
import { Heart, ListMusic } from "lucide-react";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { PlaylistRow } from "@/lib/db-types";

export const revalidate = 0;

export default async function LibraryPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  let playlists: Array<PlaylistRow & { songsCount: number }> = [];

  if (userId) {
    playlists = await db<PlaylistRow & { songsCount: number }>`
      SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", COUNT(ps."id") AS "songsCount"
      FROM "Playlist" p
      LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
      WHERE p."userId" = ${userId}
      GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt"
      ORDER BY p."createdAt" DESC
    `;
    playlists = playlists.map((row) => ({ ...row, songsCount: Number(row.songsCount ?? 0) }));
  }

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-5">Your Library</h1>

      <div className="space-y-2">
        <Link
          href="/liked"
          className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
        >
          <div className="h-14 w-14 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-white grid place-items-center shrink-0">
            <Heart size={24} />
          </div>
          <div>
            <div className="font-semibold">Liked Songs</div>
            <div className="text-sm opacity-70">Your favorites</div>
          </div>
        </Link>

        {userId ? (
          playlists.length > 0 ? (
            <>
              <div className="pt-4 pb-2 text-xs uppercase tracking-wide opacity-60 px-3">
                Playlists
              </div>
              {playlists.map((playlist) => (
                <Link
                  key={playlist.id}
                  href={`/playlist/${playlist.id}`}
                  className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
                >
                  <div className="h-14 w-14 rounded-lg bg-black/5 dark:bg-white/10 grid place-items-center shrink-0">
                    <ListMusic size={24} className="opacity-80" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{playlist.name}</div>
                    <div className="text-sm opacity-70">{playlist.songsCount} tracks</div>
                  </div>
                </Link>
              ))}
            </>
          ) : null
        ) : (
          <div className="px-3 py-6 text-sm opacity-70">
            <Link className="underline text-emerald-500" href="/signin">
              Sign in
            </Link>{" "}
            to view your playlists.
          </div>
        )}

        <Link
          href="/upload"
          className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation lg:hidden"
        >
          <div className="h-14 w-14 rounded-lg bg-black/5 dark:bg-white/10 grid place-items-center shrink-0 text-lg font-semibold">
            +
          </div>
          <div>
            <div className="font-semibold">Upload</div>
            <div className="text-sm opacity-70">Add new music</div>
          </div>
        </Link>
      </div>

      <div className="h-24 lg:hidden" />
    </div>
  );
}
