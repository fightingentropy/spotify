import { afterEach, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { buildSql, type SqlTag } from "../src/lib/sql-tag";
import { searchLibraryPage } from "../src/worker/library-search";
import { decodeCreatedAtIdCursor } from "../packages/shared/src/cursor-page";

let sqlite: Database;
afterEach(() => sqlite?.close());

test("ranked search scans older rows, paginates without duplicates, and isolates accounts", async () => {
  sqlite = new Database(":memory:");
  sqlite.exec('CREATE TABLE Song (id TEXT PRIMARY KEY, userId TEXT, title TEXT, artist TEXT, album TEXT, imageUrl TEXT, audioUrl TEXT, lyricsUrl TEXT, duration INTEGER, createdAt TEXT)');
  const insert = sqlite.prepare("INSERT INTO Song (id, userId, title, artist, createdAt) VALUES (?, ?, ?, ?, ?)");
  sqlite.transaction(() => {
    for (let i = 0; i < 1300; i++) insert.run(`unrelated-${i}`, "owner", "Elsewhere", "Someone", "2026-09-07");
    insert.run("old-exact", "owner", "Song 2", "Blur", "2020-01-01");
    insert.run("live", "owner", "Song 2 live", "Blur", "2026-09-07");
    insert.run("typo", "owner", "Snog 2", "Blur", "2026-09-07");
    insert.run("private", "other", "Song 2", "Blur", "2026-09-07");
  })();
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = buildSql(strings, values);
    return sqlite.query(query.sql).all(...query.params as SQLQueryBindings[]);
  }) as SqlTag;
  const first = await searchLibraryPage(db, "owner", "Song 2 Blur", 1, null);
  expect(first.rows.map((song) => song.id)).toEqual(["old-exact"]);
  const second = await searchLibraryPage(db, "owner", "Song 2 Blur", 1, decodeCreatedAtIdCursor(first.nextCursor ?? ""));
  expect(second.rows.map((song) => song.id)).toEqual(["live"]);
  const third = await searchLibraryPage(db, "owner", "Song 2 Blur", 1, decodeCreatedAtIdCursor(second.nextCursor ?? ""));
  expect(third.rows.map((song) => song.id)).toEqual(["typo"]);
  expect(third.nextCursor).toBeNull();
  const isolated = await searchLibraryPage(db, "other", "Song 2 Blur", 10, decodeCreatedAtIdCursor(first.nextCursor ?? ""));
  expect(isolated.rows).toEqual([]);
});
