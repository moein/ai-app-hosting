import { SELF } from 'cloudflare:test';
import { VALIDATOR_BUNDLE } from '@repo/app-contract';
import { describe, expect, it } from 'vitest';

describe('GET /v1/contract/validator/<version>.mjs (CON-4.4, CON-4.5)', () => {
  it('serves the bundled validator with immutable caching', async () => {
    const res = await SELF.fetch('https://api.test/v1/contract/validator/1.mjs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(VALIDATOR_BUNDLE);
  });

  it('returns NOT_FOUND for unknown versions, without caching the error', async () => {
    const res = await SELF.fetch('https://api.test/v1/contract/validator/99.mjs');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
