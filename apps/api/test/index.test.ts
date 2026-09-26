import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

describe('api entry point', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects requests with INTERNAL before reaching Hono when env is invalid', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badEnv = { ...env, PLATFORM_API_ORIGIN: 'not-a-url' } as unknown as Env;
    const res = await worker.fetch(new Request('https://api.test/healthz'), badEnv, createExecutionContext());
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL');
    const entry = JSON.parse(String(log.mock.lastCall?.[0]));
    expect(entry).toMatchObject({
      message: 'invalid worker environment',
      worker: 'api',
      variables: ['PLATFORM_API_ORIGIN'],
    });
    expect(JSON.stringify(entry)).not.toContain('not-a-url');
  });

  it('passes valid requests to the Hono app', async () => {
    const res = await worker.fetch(new Request('https://api.test/healthz'), env, createExecutionContext());
    expect(res.status).toBe(200);
  });
});
