import { LOG_MESSAGE_MAX_BYTES, LOG_STACK_MAX_BYTES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalize';
import { traceItem } from './trace';

describe('normalize (LOG-2.2–2.4)', () => {
  it('turns an ok request with console logs into a request entry plus one entry per log', () => {
    const { appId, entries } = normalize(
      traceItem({
        logs: [
          { timestamp: 1_790_000_000_001, level: 'log', message: ['loaded', 3, { a: 1 }] },
          { timestamp: 1_790_000_000_002, level: 'warn', message: ['slow'] },
          { timestamp: 1_790_000_000_003, level: 'weird', message: 'plain' },
        ],
      }),
    );
    expect(appId).toBe('app_V1StGXR8_Z5');
    expect(entries.map(({ invocation_id, ...rest }) => rest)).toEqual([
      {
        ts: 1_790_000_000_000,
        kind: 'request',
        level: 'info',
        message: 'GET /api/notes 200',
        method: 'GET',
        path: '/api/notes',
        status: 200,
        outcome: 'ok',
        duration_ms: 12,
      },
      { ts: 1_790_000_000_001, kind: 'console', level: 'log', message: 'loaded 3 {"a":1}' },
      { ts: 1_790_000_000_002, kind: 'console', level: 'warn', message: 'slow' },
      { ts: 1_790_000_000_003, kind: 'console', level: 'log', message: 'plain' },
    ]);
    expect(new Set(entries.map((e) => e.invocation_id)).size).toBe(1);
  });

  it('keeps no headers, cookies, query strings or IPs (LOG-2.3)', () => {
    const json = JSON.stringify(normalize(traceItem()).entries);
    for (const secret of ['token=secret', 'session=abc', 'Bearer', '1.2.3.4', 'todo.dev.motad.app']) {
      expect(json).not.toContain(secret);
    }
  });

  it('records exceptions and marks the request as an error', () => {
    const { entries } = normalize(
      traceItem({
        event: { request: { method: 'POST', url: 'https://x.dev.motad.app/api/x', headers: {} } },
        outcome: 'exception',
        exceptions: [{ timestamp: 5, name: 'TypeError', message: "Cannot read 'x'", stack: 'at a\nat b' }],
      }),
    );
    expect(entries[0]).toMatchObject({ kind: 'request', level: 'error', message: 'POST /api/x exception' });
    expect(entries[0]).not.toHaveProperty('status');
    expect(entries[1]).toMatchObject({
      kind: 'exception',
      level: 'error',
      message: "TypeError: Cannot read 'x'",
      stack: 'at a\nat b',
    });
  });

  it('marks exceededCpu and 5xx requests as errors', () => {
    expect(normalize(traceItem({ outcome: 'exceededCpu' })).entries[0]).toMatchObject({
      level: 'error',
      outcome: 'exceededCpu',
    });
    const five = traceItem({
      event: { request: { method: 'GET', url: 'https://x/a', headers: {} }, response: { status: 503 } },
    });
    expect(normalize(five).entries[0]).toMatchObject({ level: 'error', status: 503 });
  });

  it('truncates messages and stacks by UTF-8 bytes', () => {
    const { entries } = normalize(
      traceItem({
        logs: [{ timestamp: 1, level: 'log', message: ['é'.repeat(LOG_MESSAGE_MAX_BYTES)] }],
        exceptions: [{ timestamp: 2, name: 'E', message: 'm', stack: 'x'.repeat(LOG_STACK_MAX_BYTES * 2) }],
      }),
    );
    const bytes = (s = '') => new TextEncoder().encode(s).byteLength;
    expect(bytes(entries[1]?.message)).toBeLessThanOrEqual(LOG_MESSAGE_MAX_BYTES);
    expect(entries[1]?.message.endsWith('é…')).toBe(true);
    expect(bytes(entries[2]?.stack)).toBeLessThanOrEqual(LOG_STACK_MAX_BYTES);
  });

  it('handles non-fetch events, unserializable args and missing tags', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { appId, entries } = normalize(
      traceItem({
        event: { cron: '* * * * *' },
        scriptTags: [],
        logs: [{ timestamp: 1, level: 'info', message: [circular, 1n] }],
      }),
    );
    expect(appId).toBeNull();
    expect(entries).toEqual([expect.objectContaining({ kind: 'console', message: '[object Object] 1' })]);
  });
});
