import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  LOG_BUFFER_MAX_AGE_MS,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_INGEST_MAX_PER_MINUTE,
  type LogEntry,
  type LogFilter,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

const buffer = () => env.APP_LOGS.get(env.APP_LOGS.idFromName(`app_${crypto.randomUUID()}`));
const NOW = Date.now();
const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  ts: NOW,
  kind: 'console',
  level: 'log',
  message: 'hello',
  invocation_id: 'inv',
  ...overrides,
});
const all: LogFilter = { since: 0, until: Number.MAX_SAFE_INTEGER, limit: 200 };

describe('AppLogBuffer (LOG-2.5, LOG-2.7, LOG-3)', () => {
  it('appends and queries newest first, keeping optional fields', async () => {
    const stub = buffer();
    await stub.append([
      entry({ ts: NOW - 2, message: 'old' }),
      entry({
        ts: NOW,
        kind: 'request',
        level: 'info',
        message: 'GET / 200',
        method: 'GET',
        path: '/',
        status: 200,
        outcome: 'ok',
        duration_ms: 3,
      }),
      entry({ ts: NOW - 1, kind: 'exception', level: 'error', message: 'E: x', stack: 'at y' }),
    ]);
    const page = await stub.query(all);
    expect(page.entries.map((e) => e.message)).toEqual(['GET / 200', 'E: x', 'old']);
    expect(page.entries[0]).toEqual(
      entry({
        ts: NOW,
        kind: 'request',
        level: 'info',
        message: 'GET / 200',
        method: 'GET',
        path: '/',
        status: 200,
        outcome: 'ok',
        duration_ms: 3,
      }),
    );
    expect(page.entries[1]?.stack).toBe('at y');
    expect(page.next_cursor).toBeNull();
  });

  it('filters by time window, level, kind, search and status_min', async () => {
    const stub = buffer();
    await stub.append([
      entry({ ts: NOW - 10_000, message: 'too old' }),
      entry({ ts: NOW, level: 'debug', message: 'dbg' }),
      entry({ ts: NOW, level: 'info', message: 'Info Line' }),
      entry({ ts: NOW, level: 'warn', message: 'careful' }),
      entry({ ts: NOW, kind: 'exception', level: 'error', message: 'Boom' }),
      entry({
        ts: NOW,
        kind: 'request',
        level: 'info',
        message: 'GET /api/users 200',
        path: '/api/users',
        status: 200,
      }),
      entry({ ts: NOW, kind: 'request', level: 'error', message: 'GET /api/x 500', path: '/api/x', status: 500 }),
    ]);
    const messages = async (f: Partial<LogFilter>) =>
      (await stub.query({ ...all, since: NOW - 5_000, ...f })).entries.map((e) => e.message).sort();
    expect(await messages({})).not.toContain('too old');
    expect(await messages({ until: NOW - 1 })).toEqual([]);
    expect(await messages({ level: 'warn' })).toEqual(['Boom', 'GET /api/x 500', 'careful']);
    expect(await messages({ level: 'info' })).not.toContain('dbg');
    expect(await messages({ kind: 'exception' })).toEqual(['Boom']);
    expect(await messages({ search: 'info line' })).toEqual(['Info Line']);
    expect(await messages({ search: '/API/USERS' })).toEqual(['GET /api/users 200']);
    expect(await messages({ search: '%' })).toEqual([]);
    expect(await messages({ status_min: 500 })).toEqual(['GET /api/x 500']);
  });

  it('paginates with a cursor, including entries sharing a timestamp', async () => {
    const stub = buffer();
    await stub.append(Array.from({ length: 7 }, (_, i) => entry({ ts: NOW - Math.floor(i / 2), message: `m${i}` })));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await stub.query({ ...all, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.entries.map((e) => e.message));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['m1', 'm0', 'm3', 'm2', 'm5', 'm4', 'm6']);
  });

  it('keeps at most LOG_BUFFER_MAX_ENTRIES, dropping the oldest', async () => {
    const stub = buffer();
    const batch = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => entry({ ts: NOW + (start + i) * 60_000, message: `m${start + i}` }));
    await stub.append(batch(0, LOG_BUFFER_MAX_ENTRIES));
    await stub.append(batch(LOG_BUFFER_MAX_ENTRIES, 3));
    await runInDurableObject(stub, (_, state) => {
      expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM logs').one().n).toBe(
        LOG_BUFFER_MAX_ENTRIES,
      );
      expect(state.storage.sql.exec<{ m: string }>('SELECT message AS m FROM logs ORDER BY seq LIMIT 1').one().m).toBe(
        'm3',
      );
    });
  });

  it('deletes entries older than LOG_BUFFER_MAX_AGE_MS in the hourly alarm', async () => {
    const stub = buffer();
    await stub.append([
      entry({ ts: Date.now() - LOG_BUFFER_MAX_AGE_MS - 1, message: 'expired' }),
      entry({ message: 'fresh' }),
    ]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.query(all)).entries.map((e) => e.message)).toEqual(['fresh']);
    await runInDurableObject(stub, async (_, state) => expect(await state.storage.getAlarm()).not.toBeNull());
  });

  it('over the per-minute cap keeps requests and exceptions, drops console entries and records one dropped entry', async () => {
    const stub = buffer();
    const minute = Math.floor(NOW / 60_000) * 60_000;
    await stub.append(Array.from({ length: LOG_INGEST_MAX_PER_MINUTE }, () => entry({ ts: minute })));
    await stub.append([
      entry({ ts: minute + 1, message: 'lost 1' }),
      entry({ ts: minute + 2, kind: 'request', level: 'info', message: 'kept request' }),
      entry({ ts: minute + 3, kind: 'exception', level: 'error', message: 'kept exception' }),
      entry({ ts: minute + 4, message: 'lost 2' }),
    ]);
    await stub.append([entry({ ts: minute + 5, message: 'lost 3' })]);
    await stub.append([entry({ ts: minute + 60_000, message: 'next minute' })]);

    const recent = (await stub.query({ ...all, search: '' })).entries;
    const messages = (await stub.query({ ...all, kind: 'request' })).entries.map((e) => e.message);
    expect(messages).toEqual(['kept request']);
    expect((await stub.query({ ...all, kind: 'exception' })).entries).toHaveLength(1);
    const all200 = await stub.query({ ...all, level: 'warn' });
    const dropped = all200.entries.filter((e) => e.kind === 'dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.message).toMatch(/^3 console entries dropped/);
    expect(recent.some((e) => e.message.startsWith('lost'))).toBe(false);
    expect(recent.some((e) => e.message === 'next minute')).toBe(true);
  });

  it('purge() removes every entry and the alarm', async () => {
    const stub = buffer();
    await stub.append([entry()]);
    await stub.purge();
    expect((await stub.query(all)).entries).toEqual([]);
    await runInDurableObject(stub, async (_, state) => expect(await state.storage.getAlarm()).toBeNull());
  });
});
