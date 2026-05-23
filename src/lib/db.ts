import type { CloudflareD1Database } from "@/lib/cloudflare";
import { getCloudflareBindings } from "@/lib/cloudflare";
import {
  buildSql,
  statementReturnsRows,
  type SqlRow,
  type SqlTag,
  type TemplateValue,
} from "@/lib/sql-tag";

declare global {
  var __waveformDb: SqlTag | undefined;
}

function createD1SqlTag(d1: CloudflareD1Database): SqlTag {
  const tag = (async function d1Tag<T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]> {
    const { sql, params } = buildSql(strings, values);
    const statement = d1.prepare(sql);
    if (statementReturnsRows(sql)) {
      const result = await statement.bind(...params).all<T>();
      return result.results ?? [];
    }
    await statement.bind(...params).run();
    return [];
  }) as SqlTag;

  tag.end = async () => {};
  return tag;
}

function createDbProxy(): SqlTag {
  let localDb: SqlTag | null = null;
  let localDbPromise: Promise<SqlTag> | null = null;

  const getLocalDb = async (): Promise<SqlTag> => {
    if (localDb) {
      return localDb;
    }
    if (!localDbPromise) {
      localDbPromise = (Function(
        'return import("@/lib/db-local")',
      ) as () => Promise<{ createLocalSqlTag: () => SqlTag }>)().then(
        ({ createLocalSqlTag }) => {
          const created = globalThis.__waveformDb ?? createLocalSqlTag();
          if (process.env.NODE_ENV !== "production") {
            globalThis.__waveformDb = created;
          }
          localDb = created;
          return created;
        },
      );
    }
    return localDbPromise;
  };

  const tag = (async function dbProxy<T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]> {
    const bindings = await getCloudflareBindings();
    if (bindings) {
      return createD1SqlTag(bindings.DB)<T>(strings, ...values);
    }
    const db = await getLocalDb();
    return db<T>(strings, ...values);
  }) as SqlTag;

  tag.end = async (opts) => {
    const bindings = await getCloudflareBindings();
    if (bindings) {
      return;
    }
    const db = await getLocalDb();
    await db.end(opts);
  };

  return tag;
}

export const db = createDbProxy();
export type Db = typeof db;
