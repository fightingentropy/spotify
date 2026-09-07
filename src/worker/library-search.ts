import type { SongRow } from "../lib/db-types";
import type { SqlTag } from "../lib/sql-tag";
import { scoreLibrarySong } from "../../packages/shared/src/library-search";
import { encodeCreatedAtIdCursor, type CreatedAtIdCursor } from "../../packages/shared/src/cursor-page";

type Match = { row: SongRow; score: number };
const descending = (a: string, b: string) => a === b ? 0 : a > b ? -1 : 1;
const compare = (a: Match, b: Match) => b.score - a.score ||
  descending(String(a.row.createdAt), String(b.row.createdAt)) || descending(a.row.id, b.row.id);

// Search the owner-scoped metadata in bounded pages, retaining only the requested
// best matches. SQLite's ASCII LIKE cannot share the clients' accent/typo rules.
// Keyset reads avoid a first-N cutoff that would hide older recordings.
export async function searchLibraryPage(
  db: SqlTag,
  userId: string,
  query: string,
  limit: number,
  cursor: CreatedAtIdCursor | null,
): Promise<{ rows: SongRow[]; nextCursor: string | null }> {
  let after: Match | null = null;
  if (cursor) {
    const [row] = await db<SongRow>`SELECT * FROM "Song" WHERE "userId" = ${userId} AND "id" = ${cursor.id} AND "createdAt" = ${cursor.createdAt} LIMIT 1`;
    if (!row) return { rows: [], nextCursor: null };
    after = { row, score: scoreLibrarySong(row, query) };
  }
  let scan: CreatedAtIdCursor | null = null;
  let matches: Match[] = [];
  const batchSize = 1000;
  while (true) {
    const rows: SongRow[] = scan
      ? await db<SongRow>`
          SELECT "id", "title", "artist", "album", "imageUrl", "audioUrl", "lyricsUrl", "duration", "createdAt"
          FROM "Song" WHERE "userId" = ${userId}
            AND ("createdAt" < ${scan.createdAt} OR ("createdAt" = ${scan.createdAt} AND "id" < ${scan.id}))
          ORDER BY "createdAt" DESC, "id" DESC LIMIT ${batchSize}`
      : await db<SongRow>`
          SELECT "id", "title", "artist", "album", "imageUrl", "audioUrl", "lyricsUrl", "duration", "createdAt"
          FROM "Song" WHERE "userId" = ${userId}
          ORDER BY "createdAt" DESC, "id" DESC LIMIT ${batchSize}`;
    for (const row of rows) {
      const match = { row, score: scoreLibrarySong(row, query) };
      if (match.score > 0 && (!after || compare(match, after) > 0)) matches.push(match);
    }
    matches.sort(compare);
    matches = matches.slice(0, limit + 1);
    if (rows.length < batchSize) break;
    const last = rows[rows.length - 1];
    scan = { createdAt: String(last.createdAt), id: last.id };
  }
  const rows = matches.slice(0, limit).map((match) => match.row);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: matches.length > limit && last ? encodeCreatedAtIdCursor(String(last.createdAt), last.id) : null,
  };
}
