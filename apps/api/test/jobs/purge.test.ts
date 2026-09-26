import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { loginCodes } from '../../src/db/schema';
import { LOGIN_CODE_RETENTION_MS, purgeLoginCodes } from '../../src/jobs/purge-login-codes';

describe('login code purge', () => {
  it('deletes codes older than 7 days and keeps newer ones', async () => {
    const db = createDb(env.DB);
    const now = Date.UTC(2026, 8, 26);
    const row = (id: string, createdAt: number) => ({
      id,
      email: 'a@b.co',
      codeHash: 'x',
      createdAt,
      expiresAt: createdAt,
    });
    await db.insert(loginCodes).values([row('lc_old', now - LOGIN_CODE_RETENTION_MS - 1), row('lc_new', now - 1_000)]);
    expect(await purgeLoginCodes(db, now)).toBe(1);
    expect((await db.select().from(loginCodes).all()).map((r) => r.id)).toEqual(['lc_new']);
  });
});
