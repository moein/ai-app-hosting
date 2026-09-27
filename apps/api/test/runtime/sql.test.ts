import { describe, expect, it } from 'vitest';
import { isReadOnly, splitStatements, touchesProtectedTables } from '../../src/runtime/sql';

describe('read-only classifier (RUN-4.2)', () => {
  it.each([
    ['SELECT * FROM notes', true],
    ['  select 1', true],
    ['EXPLAIN QUERY PLAN SELECT * FROM notes', true],
    ['PRAGMA table_info(notes)', true],
    ['PRAGMA main.table_list', true],
    ['PRAGMA index_list(notes)', true],
    ['PRAGMA foreign_key_list(notes)', true],
    ['PRAGMA foreign_keys = OFF', false],
    ['PRAGMA journal_mode', false],
    ['INSERT INTO notes (body) VALUES (1)', false],
    ['UPDATE notes SET body = 1', false],
    ['DELETE FROM notes', false],
    ['DROP TABLE notes', false],
    ['WITH x AS (SELECT 1) SELECT * FROM x', false],
    ['CREATE TABLE t (id INTEGER)', false],
  ])('%s → %s', (sql, readOnly) => {
    expect(isReadOnly(sql)).toBe(readOnly);
  });

  it('splits on top-level semicolons, ignoring comments and string literals', () => {
    expect(splitStatements('SELECT 1; DROP TABLE notes')).toEqual(['SELECT 1', 'DROP TABLE notes']);
    expect(splitStatements('SELECT 1;  -- trailing\n')).toEqual(['SELECT 1']);
    expect(splitStatements('SELECT \'a;b\', "c;" /* ; */ FROM t;')).toHaveLength(1);
    expect(splitStatements("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"]);
    expect(splitStatements('-- only a comment')).toEqual([]);
    expect(splitStatements('/* x */ DELETE FROM notes')[0]).toMatch(/^DELETE/);
  });

  it('detects platform tables (RUN-4.3)', () => {
    expect(touchesProtectedTables('DELETE FROM _platform_migrations')).toBe(true);
    expect(touchesProtectedTables('DROP TABLE _cf_KV')).toBe(true);
    expect(touchesProtectedTables('DELETE FROM notes')).toBe(false);
  });
});
