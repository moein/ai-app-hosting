import { PlatformError, QUERY_MAX_ROWS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { queryDatabase } from '../../src/tools/runtime/query-database';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

type Result = { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean; meta: object };
const data = <T = Result>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) =>
  (r.structuredContent as { error: { code: string; message: string; details?: { message?: string } } }).error;

// The fake runs app SQL against the test D1, so each test uses its own table.
async function setup(): Promise<{ ctx: TestContext; slug: string; table: string }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = data<{ slug: string }>(
    await runTool(createApp, { name: `Q ${Math.random().toString(36).slice(2, 8)}` }, ctx),
  );
  const table = `q_${Math.random().toString(36).slice(2, 10)}`;
  await runTool(
    queryDatabase,
    { app: slug, sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, body TEXT)`, allow_writes: true },
    ctx,
  );
  return { ctx, slug, table };
}

describe('query_database (RUN-4)', () => {
  it('runs a read with params and returns columns, rows and meta', async () => {
    const { ctx, slug, table } = await setup();
    await runTool(
      queryDatabase,
      { app: slug, sql: `INSERT INTO ${table} (body) VALUES (?), (?)`, params: ['a', 'b'], allow_writes: true },
      ctx,
    );
    const result = data(
      await runTool(
        queryDatabase,
        { app: slug, sql: `SELECT id, body FROM ${table} WHERE body = ?`, params: ['b'] },
        ctx,
      ),
    );
    expect(result).toMatchObject({ columns: ['id', 'body'], rows: [[2, 'b']], row_count: 1, truncated: false });
    expect(result.meta).toHaveProperty('rows_read');
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'DELETE FROM t',
    'DROP TABLE t',
    'WITH x AS (SELECT 1) DELETE FROM t',
    'PRAGMA foreign_keys = OFF',
  ])('rejects %s without allow_writes', async (sql) => {
    const { ctx, slug } = await setup();
    const error = errorOf(await runTool(queryDatabase, { app: slug, sql }, ctx));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('allow_writes');
  });

  it('rejects more than one statement even with allow_writes', async () => {
    const { ctx, slug, table } = await setup();
    for (const allow_writes of [false, true]) {
      const r = await runTool(queryDatabase, { app: slug, sql: `SELECT 1; DROP TABLE ${table}`, allow_writes }, ctx);
      expect(errorOf(r).code).toBe('INVALID_INPUT');
    }
    expect(
      data(await runTool(queryDatabase, { app: slug, sql: `SELECT count(*) AS n FROM ${table};` }, ctx)).rows,
    ).toEqual([[0]]);
  });

  it('never writes platform tables (RUN-4.3)', async () => {
    const { ctx, slug } = await setup();
    for (const sql of ['DELETE FROM _platform_migrations', 'DROP TABLE _cf_KV']) {
      expect(errorOf(await runTool(queryDatabase, { app: slug, sql, allow_writes: true }, ctx)).code).toBe(
        'INVALID_INPUT',
      );
    }
    expect(ctx.fakes.cloudflare.calls.filter((c) => c.method === 'd1Query')).toHaveLength(1); // only the setup CREATE
  });

  it('truncates by rows and by bytes (RUN-4.4)', async () => {
    const { ctx, slug, table } = await setup();
    const many = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${QUERY_MAX_ROWS + 50}) INSERT INTO ${table} (body) SELECT 'row' FROM n`;
    await runTool(queryDatabase, { app: slug, sql: many, allow_writes: true }, ctx);
    const byRows = data(await runTool(queryDatabase, { app: slug, sql: `SELECT * FROM ${table}` }, ctx));
    expect(byRows).toMatchObject({ row_count: QUERY_MAX_ROWS + 50, truncated: true });
    expect(byRows.rows).toHaveLength(QUERY_MAX_ROWS);

    const byBytes = data(
      await runTool(
        queryDatabase,
        { app: slug, sql: `SELECT id, printf('%.2000c', 'x') AS pad FROM ${table} LIMIT 100` },
        ctx,
      ),
    );
    expect(byBytes.truncated).toBe(true);
    expect(byBytes.rows.length).toBeLessThan(100);
    expect(JSON.stringify(byBytes.rows).length).toBeLessThanOrEqual(80_000);
  });

  it('reports D1 errors as QUERY_FAILED with the message (RUN-4.5)', async () => {
    const { ctx, slug } = await setup();
    const error = errorOf(await runTool(queryDatabase, { app: slug, sql: 'SELECT * FROM no_such_table' }, ctx));
    expect(error.code).toBe('QUERY_FAILED');
    expect(error.details?.message).toContain('no_such_table');

    ctx.fakes.cloudflare.failNext(
      'd1Query',
      new PlatformError('UPSTREAM_ERROR', { details: { status: 400, errors: ['near "x": syntax error'] } }),
    );
    expect(errorOf(await runTool(queryDatabase, { app: slug, sql: 'SELECT x x x' }, ctx)).details?.message).toBe(
      'near "x": syntax error',
    );

    ctx.fakes.cloudflare.failNext('d1Query', new PlatformError('UPSTREAM_ERROR'));
    expect(errorOf(await runTool(queryDatabase, { app: slug, sql: 'SELECT 1' }, ctx)).code).toBe('UPSTREAM_ERROR');
  });
});
