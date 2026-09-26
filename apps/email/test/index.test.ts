import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('email skeleton', () => {
  it('serves no HTTP routes', async () => {
    expect((await SELF.fetch('https://email.test/')).status).toBe(404);
  });
});
