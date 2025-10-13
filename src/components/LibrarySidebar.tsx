import "server-only";

import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { Library, Heart, ListMusic, Plus } from "lucide-react";
import { db } from "@/lib/db";
import type { PlaylistRow } from "@/lib/db-types";

export default async function LibrarySidebar() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  let likesCount = 0;
  let playlists: Array<PlaylistRow & { songsCount: number }> = [];

  if (userId) {
    const [likeRows, playlistRows] = await Promise.all([
      (db`
        SELECT COUNT(*)::int AS count
        FROM "Like"
        WHERE "userId" = ${userId}
      ` as any) as Promise<{ count: number }[]>,
      (db`
        SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", COUNT(ps."id")::int AS "songsCount"
        FROM "Playlist" p
        LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
        WHERE p."userId" = ${userId}
        GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt"
        ORDER BY p."createdAt" DESC
      ` as any) as Promise<(PlaylistRow & { songsCount: number })[]>,
    ]);
    likesCount = Number(likeRows[0]?.count ?? 0);
    playlists = playlistRows.map((row) => ({ ...row, songsCount: Number(row.songsCount ?? 0) }));
  }

  return (
    <aside className="hidden lg:flex fixed top-14 bottom-0 left-0 w-64 z-40 border-r border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-sm font-medium opacity-80">
            <Library size={16} />
            <span>Your Library</span>
          </div>
          <button
            title="Create playlist (coming soon)"
            className="h-7 w-7 rounded-md grid place-items-center bg-black/5 dark:bg-white/10 opacity-70 cursor-default"
            aria-disabled
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="space-y-1">
          <Link href="/liked" className="flex items-center gap-3 px-2 py-2 rounded hover:bg-black/5 dark:hover:bg-white/5">
            <div className="h-8 w-8 rounded bg-gradient-to-br from-emerald-500 to-emerald-700 text-white grid place-items-center">
              <Heart size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">Liked Songs</div>
              <div className="text-xs opacity-70">
                {userId ? `${likesCount} liked` : "Sign in to see your likes"}
              </div>
            </div>
          </Link>

          {userId ? (
            playlists.length > 0 && (
            <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">Playlists</div>
              <div className="space-y-1">
                {playlists.map((pl) => (
                  <Link
                    key={pl.id}
                    href={`/playlist/${pl.id}`}
                    className="flex items-center gap-3 px-2 py-2 rounded hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <div className="h-8 w-8 rounded bg-black/5 dark:bg-white/10 grid place-items-center">
                      <ListMusic size={16} />
                    </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{pl.name}</div>
                      <div className="text-xs opacity-70">{pl.songsCount ?? 0} tracks</div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
            )
          ) : (
            <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">Playlists</div>
              <div className="px-2 text-sm opacity-70">
                <Link className="underline" href="/signin">Sign in</Link> to manage playlists.
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
