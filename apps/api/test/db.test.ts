import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';

describe('platform D1 (FND-6)', () => {
  it('has migrations applied before tests run', async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toContain('d1_migrations');
  });

  it('is reachable through the Drizzle client', async () => {
    const db = createDb(env.DB);
    const [row] = await db.all<{ one: number }>(sql`SELECT 1 AS one`);
    expect(row?.one).toBe(1);
  });
});
