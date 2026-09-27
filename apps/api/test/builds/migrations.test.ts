import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/builds/migrations';
import { fakeCloudflare } from '../fakes/cloudflare';

const cf = () => fakeCloudflare({ d1: env.DB });
const m = (name: string, sql: string) => ({ name, sql });

describe('migrations runner (DEP-2.7, DEP-2.8)', () => {
  it('applies new migrations in order, records them, and skips applied ones', async () => {
    const { client } = cf();
    const first = await applyMigrations(
      client,
      'db',
      [m('0002_more.sql', 'INSERT INTO t1 (v) VALUES (2);'), m('0001_t.sql', 'CREATE TABLE t1 (v INTEGER);')],
      1,
    );
    expect(first.applied).toEqual(['0001_t.sql', '0002_more.sql']);
    const again = await applyMigrations(
      client,
      'db',
      [m('0001_t.sql', 'CREATE TABLE t1 (v INTEGER);'), m('0002_more.sql', 'INSERT INTO t1 (v) VALUES (2);')],
      2,
    );
    expect(again.applied).toEqual([]);
    const rows = await env.DB.prepare('SELECT name FROM _platform_migrations ORDER BY name').all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(['0001_t.sql', '0002_more.sql']);
  });

  it('rejects an edited applied migration, naming the file', async () => {
    const { client } = cf();
    await applyMigrations(client, 'db', [m('0001_x.sql', 'CREATE TABLE tx (v INTEGER);')], 1);
    await expect(
      applyMigrations(client, 'db', [m('0001_x.sql', 'CREATE TABLE tx (v TEXT);')], 2),
    ).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      details: { file: '0001_x.sql' },
    });
  });

  it('stops at a failing statement and does not record it', async () => {
    const { client } = cf();
    await expect(
      applyMigrations(
        client,
        'db',
        [m('0001_bad.sql', 'CREATE TABLE ('), m('0002_after.sql', 'CREATE TABLE after_bad (v INTEGER);')],
        1,
      ),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED', details: { file: '0001_bad.sql' } });
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'after_bad'").all();
    expect(rows.results).toEqual([]);
  });
});
