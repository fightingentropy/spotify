import "server-only";

import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { db } from "@/lib/db";
import type { PlaylistRow } from "@/lib/db-types";
import LibrarySidebarClient from "@/components/LibrarySidebarClient";

type LibrarySidebarProps = {
  initialCollapsed?: boolean;
};

export default async function LibrarySidebar({
  initialCollapsed = false,
}: LibrarySidebarProps) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  let playlists: Array<PlaylistRow & { songsCount: number }> = [];

  if (userId) {
    const playlistRows = (await db`
        SELECT p."id", p."name", p."imageUrl", p."userId", p."createdAt", COUNT(ps."id") AS "songsCount"
        FROM "Playlist" p
        LEFT JOIN "PlaylistSong" ps ON ps."playlistId" = p."id"
        WHERE p."userId" = ${userId}
        GROUP BY p."id", p."name", p."imageUrl", p."userId", p."createdAt"
        ORDER BY p."createdAt" DESC
      ` as any) as (PlaylistRow & { songsCount: number })[];
    playlists = playlistRows.map((row) => ({ ...row, songsCount: Number(row.songsCount ?? 0) }));
  }

  return (
    <LibrarySidebarClient
      userId={userId}
      playlists={playlists}
      initialCollapsed={initialCollapsed}
    />
  );
}
