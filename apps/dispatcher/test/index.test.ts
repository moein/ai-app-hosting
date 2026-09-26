import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('dispatcher skeleton', () => {
  it('responds with the 404 page', async () => {
    const res = await SELF.fetch('https://todo.dev.motad.app/');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no app');
  });
});
