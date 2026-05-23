export type TemplateValue = unknown;
export type SqlRow = Record<string, unknown>;

export type SqlTag = {
  <T = SqlRow>(
    strings: TemplateStringsArray,
    ...values: TemplateValue[]
  ): Promise<T[]>;
  end: (_opts?: { timeout?: number }) => Promise<void>;
};

export function buildSql(
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

export function statementReturnsRows(sql: string): boolean {
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
