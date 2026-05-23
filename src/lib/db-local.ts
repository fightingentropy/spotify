import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { env } from "@/lib/env";
import {
  buildSql,
  statementReturnsRows,
  type SqlRow,
  type SqlTag,
  type TemplateValue,
} from "@/lib/sql-tag";

type StatementLike = {
  all: (...bindings: unknown[]) => unknown[];
  run: (...bindings: unknown[]) => unknown;
};

type SqliteLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
  close: () => void;
};

const requireFromModule = createRequire(import.meta.url);

function createSqliteDriver(dbPath: string): SqliteLike {
  const BetterSqlite3 = requireFromModule("better-sqlite3") as new (
    path: string,
  ) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      all: (...bindings: unknown[]) => unknown[];
      run: (...bindings: unknown[]) => unknown;
    };
    close: () => void;
  };
  const nodeDb = new BetterSqlite3(dbPath);
  return {
    exec: (sql) => nodeDb.exec(sql),
    prepare: (sql) => nodeDb.prepare(sql),
    close: () => nodeDb.close(),
  };
}

export function createLocalSqlTag(): SqlTag {
  const dbPath = resolve(env.SQLITE_DB_PATH);
  const sqlite = createSqliteDriver(dbPath);
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  try {
    sqlite.exec("PRAGMA journal_mode = WAL;");
  } catch {}
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA temp_store = MEMORY;");

  const schemaPath = resolve(process.cwd(), "db", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");
  sqlite.exec(schemaSql);

  const STATEMENT_CACHE_LIMIT = 256;
  const statementCache = new Map<string, StatementLike>();
  const getStatement = (sql: string): StatementLike => {
    const cached = statementCache.get(sql);
    if (cached) {
      statementCache.delete(sql);
      statementCache.set(sql, cached);
      return cached;
    }
    const prepared = sqlite.prepare(sql);
    statementCache.set(sql, prepared);
    if (statementCache.size > STATEMENT_CACHE_LIMIT) {
      const oldestKey = statementCache.keys().next().value;
      if (oldestKey !== undefined) statementCache.delete(oldestKey);
    }
    return prepared;
  };

  const tag = (async function dbTag<T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]> {
    const { sql, params } = buildSql(strings, values);
    const statement = getStatement(sql);
    if (statementReturnsRows(sql)) {
      return (statement.all(...params) as T[]) ?? [];
    }
    statement.run(...params);
    return [];
  }) as SqlTag;

  tag.end = async () => {
    statementCache.clear();
    sqlite.close();
  };

  return tag;
}
