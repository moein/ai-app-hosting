import { PlatformError } from '@repo/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler, notFoundHandler } from '../src/errors';
import { type RequestIdVariables, requestId } from '../src/request-id';

const appThatThrows = (error: unknown) => {
  const app = new Hono<{ Variables: RequestIdVariables }>().use('*', requestId()).get('/', () => {
    throw error;
  });
  app.onError(errorHandler());
  return app;
};

describe('errorHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs unexpected errors through the logger and returns a generic INTERNAL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appThatThrows(new Error('db exploded')).request('/', { headers: { 'cf-ray': 'ray-1' } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).not.toContain('db exploded');
    const entry = JSON.parse(String(log.mock.lastCall?.[0]));
    expect(entry).toMatchObject({
      level: 'error',
      message: 'unhandled error',
      requestId: 'ray-1',
      error: { name: 'Error', message: 'db exploded' },
    });
  });

  it('returns PlatformErrors with their status and does not log them as unhandled', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appThatThrows(new PlatformError('RATE_LIMITED', { details: { retry_after_seconds: 5 } })).request(
      '/',
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(log).not.toHaveBeenCalled();
  });

  it('returns a NOT_FOUND PlatformError for unknown routes', async () => {
    const app = new Hono<{ Variables: RequestIdVariables }>().use('*', requestId());
    app.notFound(notFoundHandler());
    const res = await app.request('/missing');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
