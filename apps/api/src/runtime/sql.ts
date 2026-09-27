/** Removes comments outside string literals and splits on top-level semicolons. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i] as string;
    const next = sql[i + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
    } else if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      current += ' ';
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      current += ' ';
    } else if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const READ_ONLY_PRAGMAS = new Set(['table_info', 'table_list', 'index_list', 'index_info', 'foreign_key_list']);

/** RUN-4.2: SELECT, EXPLAIN and a few inspection PRAGMAs are read-only. WITH may wrap writes, so it isn't. */
export function isReadOnly(statement: string): boolean {
  const keyword = /^\s*([a-z]+)/i.exec(statement)?.[1]?.toUpperCase();
  if (keyword === 'SELECT' || keyword === 'EXPLAIN') return true;
  if (keyword === 'PRAGMA') {
    const name = /^\s*pragma\s+(?:\w+\.)?(\w+)/i.exec(statement)?.[1]?.toLowerCase() ?? '';
    return READ_ONLY_PRAGMAS.has(name) && !statement.includes('=');
  }
  return false;
}

/** RUN-4.3: platform bookkeeping and Cloudflare internals are never writable. */
export const touchesProtectedTables = (statement: string) => /\b(_platform_migrations|_cf_\w*)\b/i.test(statement);
