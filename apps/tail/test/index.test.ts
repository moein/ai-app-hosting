import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('tail skeleton', () => {
  it('accepts a batch of trace events without throwing', async () => {
    await expect(worker.tail([], env)).resolves.toBeUndefined();
  });
});
