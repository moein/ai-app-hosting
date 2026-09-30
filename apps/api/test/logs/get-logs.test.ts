import type { LogEntry } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apps } from '../../src/db/schema';
import { parseTimeArg } from '../../src/logs/time';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { getLogs } from '../../src/tools/logs/get-logs';
import { errorJson, signIn, type TestContext, testContext } from '../mcp/helpers';

type Page = { entries: (Omit<LogEntry, 'ts'> & { ts: string })[]; next_cursor: string | null; next_step?: string };
const data = <T = Page>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => errorJson(r);

async function appWithLogs(live = true): Promise<{ ctx: TestContext; slug: string; appId: string; now: number }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = data<{ slug: string }>(
    await runTool(createApp, { name: `Logs ${Math.random().toString(36).slice(2, 8)}` }, ctx),
  );
  const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
  const appId = app?.id as string;
  if (live) await ctx.db.update(apps).set({ liveDeploymentId: 'dep_live0000001' }).where(eq(apps.id, appId));
  return { ctx, slug, appId, now: ctx.clock.now() };
}

const e = (ts: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts,
  kind: 'console',
  level: 'log',
  message: 'line',
  invocation_id: 'inv',
  ...overrides,
});

describe('parseTimeArg (LOG-3.2)', () => {
  const now = Date.UTC(2026, 8, 27, 12);
  it.each([
    ['15m', now - 15 * 60_000],
    ['2h', now - 2 * 3_600_000],
    ['1d', now - 86_400_000],
    ['2026-09-27T10:00:00Z', Date.UTC(2026, 8, 27, 10)],
    ['2026-09-27T10:00:00.500+02:00', Date.UTC(2026, 8, 27, 8, 0, 0, 500)],
  ])('%s', (value, expected) => expect(parseTimeArg(value, now, 'since')).toBe(expected));

  it.each(['yesterday', '15', '5w', '-1h', '2026-13-45T99:00:00Z'])('rejects %s', (value) =>
    expect(() => parseTimeArg(value, now, 'since')).toThrowError(/since/),
  );
});

describe('get_logs (LOG-3)', () => {
  it('returns entries newest first with ISO timestamps, from the last hour by default', async () => {
    const { ctx, slug, appId, now } = await appWithLogs();
    await ctx
      .appLogs(appId)
      .append([
        e(now - 2 * 3_600_000, { message: 'two hours ago' }),
        e(now - 60_000, { message: 'a minute ago' }),
        e(now - 1_000, { kind: 'request', level: 'info', message: 'GET / 200', method: 'GET', path: '/', status: 200 }),
      ]);
    const page = data(await runTool(getLogs, { app: slug }, ctx));
    expect(page.entries.map((x) => x.message)).toEqual(['GET / 200', 'a minute ago']);
    expect(page.entries[0]).toMatchObject({ ts: new Date(now - 1_000).toISOString(), status: 200, path: '/' });
    expect(page.next_cursor).toBeNull();
    expect(data(await runTool(getLogs, { app: slug, since: '3h' }, ctx)).entries).toHaveLength(3);
    expect(
      data(await runTool(getLogs, { app: slug, since: '3h', until: '90m' }, ctx)).entries.map((x) => x.message),
    ).toEqual(['two hours ago']);
  });

  it('applies level (ordered), kind, search and status_min filters', async () => {
    const { ctx, slug, appId, now } = await appWithLogs();
    await ctx.appLogs(appId).append([
      e(now - 5, { level: 'debug', message: 'dbg' }),
      e(now - 4, { level: 'info', message: 'Saved Note' }),
      e(now - 3, { level: 'warn', message: 'slow query' }),
      e(now - 2, { kind: 'exception', level: 'error', message: 'TypeError: x' }),
      e(now - 1, {
        kind: 'request',
        level: 'error',
        message: 'POST /api/notes 500',
        path: '/api/notes',
        status: 500,
      }),
      e(now - 1, { kind: 'request', level: 'info', message: 'GET /api/notes 404', path: '/api/notes', status: 404 }),
    ]);
    const messages = async (args: Record<string, unknown>) =>
      data(await runTool(getLogs, { app: slug, ...args }, ctx))
        .entries.map((x) => x.message)
        .sort();
    expect(await messages({ level: 'warn' })).toEqual(['POST /api/notes 500', 'TypeError: x', 'slow query']);
    expect(await messages({ level: 'info' })).not.toContain('dbg');
    expect(await messages({ level: 'debug' })).toContain('dbg');
    expect(await messages({ kind: 'exception' })).toEqual(['TypeError: x']);
    expect(await messages({ search: 'saved note' })).toEqual(['Saved Note']);
    expect(await messages({ search: '/API/NOTES' })).toHaveLength(2);
    expect(await messages({ status_min: 400 })).toEqual(['GET /api/notes 404', 'POST /api/notes 500']);
    expect(await messages({ status_min: 500 })).toEqual(['POST /api/notes 500']);
  });

  it('paginates with next_cursor and caps limit at 200', async () => {
    const { ctx, slug, appId, now } = await appWithLogs();
    await ctx.appLogs(appId).append(Array.from({ length: 205 }, (_, i) => e(now - 205 + i, { message: `m${i}` })));
    const first = data(await runTool(getLogs, { app: slug, limit: 2 }, ctx));
    expect(first.entries.map((x) => x.message)).toEqual(['m204', 'm203']);
    const second = data(await runTool(getLogs, { app: slug, limit: 2, cursor: first.next_cursor }, ctx));
    expect(second.entries.map((x) => x.message)).toEqual(['m202', 'm201']);

    const capped = data(await runTool(getLogs, { app: slug, limit: 1000 }, ctx));
    expect(capped.entries).toHaveLength(200);
    expect(capped.next_cursor).not.toBeNull();
    expect(data(await runTool(getLogs, { app: slug }, ctx)).entries).toHaveLength(50);
  });

  it('explains empty results: not deployed, no traffic, or filters too narrow (LOG-3.5)', async () => {
    const notLive = await appWithLogs(false);
    expect(data(await runTool(getLogs, { app: notLive.slug }, notLive.ctx)).next_step).toContain('no live deployment');

    const { ctx, slug, appId, now } = await appWithLogs();
    expect(data(await runTool(getLogs, { app: slug }, ctx)).next_step).toContain('No traffic');
    await ctx.appLogs(appId).append([e(now - 1)]);
    const filtered = data(await runTool(getLogs, { app: slug, kind: 'exception' }, ctx));
    expect(filtered).toMatchObject({ entries: [], next_cursor: null });
    expect(filtered.next_step).toContain('filters');
  });

  it('rejects bad times and cursors, and only reads the caller’s own apps', async () => {
    const { ctx, slug } = await appWithLogs();
    expect(errorOf(await runTool(getLogs, { app: slug, since: 'last week' }, ctx)).code).toBe('INVALID_INPUT');
    expect(errorOf(await runTool(getLogs, { app: slug, cursor: 'abc' }, ctx)).code).toBe('INVALID_INPUT');
    const other = testContext();
    await signIn(other, { email: 'stranger@example.com' });
    expect(errorOf(await runTool(getLogs, { app: slug }, other)).code).toBe('NOT_FOUND');
  });
});
