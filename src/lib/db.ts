import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { env } from "@/lib/env";

type TemplateValue = unknown;
type SqlRow = Record<string, unknown>;
// Generic tagged template: `db<UserRow>\`SELECT ...\`` narrows the return
// type at the call site without an `as any` dance.
type SqlTag = {
  <T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]>;
  end: (_opts?: { timeout?: number }) => Promise<void>;
};

type StatementLike = {
  all: (...bindings: any[]) => unknown[];
  run: (...bindings: any[]) => unknown;
};

type SqliteLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
  close: () => void;
};

declare global {
  var __waveformDb: SqlTag | undefined;
}

const requireFromModule = createRequire(import.meta.url);

function buildSql(
  strings: TemplateStringsArray,
  values: TemplateValue[],
): { sql: string; params: unknown[] } {
  let sql = "";
  for (let i = 0; i < strings.length; i += 1) {
    sql += strings[i];
    if (i < values.length) {
      sql += "?";
    }
  }
  const params = values.map((value) => {
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
  return { sql, params };
}

function statementReturnsRows(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  if (
    normalized.startsWith("SELECT") ||
    normalized.startsWith("WITH") ||
    normalized.startsWith("PRAGMA")
  ) {
    return true;
  }
  if (
    (normalized.startsWith("INSERT") ||
      normalized.startsWith("UPDATE") ||
      normalized.startsWith("DELETE")) &&
    normalized.includes(" RETURNING ")
  ) {
    return true;
  }
  return false;
}

function createSqliteDriver(dbPath: string): SqliteLike {
  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  if (isBunRuntime) {
    const { Database } = requireFromModule("bun:sqlite") as {
      Database: new (path: string, options?: Record<string, unknown>) => {
        exec: (sql: string) => void;
        query: (sql: string) => {
          all: (...bindings: any[]) => unknown[];
          run: (...bindings: any[]) => unknown;
        };
        close: (throwOnError?: boolean) => void;
      };
    };
    const bunDb = new Database(dbPath, { create: true, strict: false });
    return {
      exec: (sql) => bunDb.exec(sql),
      prepare: (sql) => {
        const query = bunDb.query(sql);
        return {
          all: (...bindings: any[]) => query.all(...bindings),
          run: (...bindings: any[]) => query.run(...bindings),
        };
      },
      close: () => bunDb.close(false),
    };
  }

  const BetterSqlite3 = requireFromModule("better-sqlite3") as new (
    path: string,
  ) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      all: (...bindings: any[]) => unknown[];
      run: (...bindings: any[]) => unknown;
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

function createDb(): SqlTag {
  const dbPath = resolve(env.SQLITE_DB_PATH);
  const sqlite = createSqliteDriver(dbPath);
  // busy_timeout must come first so later pragmas wait if another process
  // (e.g. a parallel Next.js build worker) holds the DB briefly.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  try {
    // WAL is a persistent mode; once set on the file it stays. Multiple
    // processes racing to set it can trigger SQLITE_BUSY — tolerate that.
    sqlite.exec("PRAGMA journal_mode = WAL;");
  } catch {}
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA temp_store = MEMORY;");

  const schemaPath = resolve(process.cwd(), "db", "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");
  sqlite.exec(schemaSql);

  // Prepared-statement cache keyed by SQL text. SQLite parses+plans each
  // prepare; caching avoids that on every hot-path query.
  const STATEMENT_CACHE_LIMIT = 256;
  const statementCache = new Map<string, StatementLike>();
  const getStatement = (sql: string): StatementLike => {
    const cached = statementCache.get(sql);
    if (cached) {
      // LRU touch: re-insert to move to end.
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
    const bindings = params as unknown[];
    const statement = getStatement(sql);
    if (statementReturnsRows(sql)) {
      return (statement.all(...bindings) as T[]) ?? [];
    }
    statement.run(...bindings);
    return [];
  }) as SqlTag;

  tag.end = async () => {
    statementCache.clear();
    sqlite.close();
  };

  return tag;
}

const dbInstance = globalThis.__waveformDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalThis.__waveformDb = dbInstance;
}

export const db = dbInstance;

export type Db = typeof dbInstance;
