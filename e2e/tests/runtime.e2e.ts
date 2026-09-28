import { createHash, randomBytes } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createReadyApp, deleteApps, waitForStatus } from '../src/apps';
import { logIn } from '../src/auth';
import { isImplemented } from '../src/catalog';
import { fixtureFiles, writeAndDeploy } from '../src/deploy';
import { e2eEnv } from '../src/env';
import { flow, slowIt } from '../src/flows';
import { waitForEmail } from '../src/inbox';
import { callTool, connect } from '../src/mcp';
import { platformQuery } from '../src/platform-db';
import { appName, runId, testEmail } from '../src/run';

let client: Client;
let slug = '';

const until = async <T>(check: () => Promise<T | undefined>, timeoutMs: number, everyMs = 5_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
};
const api = (path: string, init?: RequestInit) => fetch(`${appUrl(slug)}${path}`, init);
const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Needs a live deployment (Workers Paid plan on the account); runs once F-RUN-1 is marked implemented.
describe.skipIf(!isImplemented('F-RUN-1'))('app runtime', () => {
  beforeAll(async () => {
    client = await connect();
    await logIn(client, testEmail('runtime'));
    slug = (await createReadyApp(client, appName('runtime'))).slug;
    const deployment = await writeAndDeploy(client, slug, fixtureFiles(), 'Contract app');
    expect(deployment.status, JSON.stringify(deployment)).toBe('live');
    await waitForStatus(`${appUrl(slug)}/api/health`, 200);
  });

  afterAll(async () => {
    await deleteApps(client, [slug]);
    await client.close();
  });

  it(flow('F-RUN-1', 'secrets reach the running app without a redeploy and are never listed with values'), async () => {
    const value = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(value).digest('hex');
    expect((await callTool(client, 'set_secret', { app: slug, name: 'E2E_SECRET', value })).ok).toBe(true);
    await until(async () => {
      const body = (await (await api('/api/secret-hash?name=E2E_SECRET')).json()) as { hash: string | null };
      return body.hash === hash ? true : undefined;
    }, 60_000);
    const listed = await callTool<{ secrets: { name: string }[] }>(client, 'list_secrets', { app: slug });
    expect(listed.ok && listed.data.secrets.map((s) => s.name)).toEqual(['E2E_SECRET']);
    expect(JSON.stringify(listed)).not.toContain(value);
    expect((await callTool(client, 'delete_secret', { app: slug, name: 'E2E_SECRET' })).ok).toBe(true);
    await until(async () => {
      const body = (await (await api('/api/secret-hash?name=E2E_SECRET')).json()) as { hash: string | null };
      return body.hash === null ? true : undefined;
    }, 60_000);
  });

  it(flow('F-RUN-2', 'query_database reads; writes need allow_writes'), async () => {
    const read = await callTool<{ rows: unknown[][] }>(client, 'query_database', {
      app: slug,
      sql: 'SELECT count(*) AS n FROM notes',
    });
    expect(read.ok && read.data.rows).toEqual([[1]]);
    const refused = await callTool(client, 'query_database', {
      app: slug,
      sql: "INSERT INTO notes (body) VALUES ('x')",
    });
    expect(!refused.ok && refused.error.code).toBe('INVALID_INPUT');
    const written = await callTool<{ meta: { rows_written: number } }>(client, 'query_database', {
      app: slug,
      sql: 'INSERT INTO notes (body) VALUES (?)',
      params: ['from e2e'],
      allow_writes: true,
    });
    expect(written.ok && written.data.meta.rows_written).toBeGreaterThanOrEqual(1);
    expect(await (await api('/api/health')).json()).toEqual({ ok: true, notes: 2 });
  });

  it(flow('F-LOG-1', 'get_logs shows the request, console output and the exception'), async () => {
    const marker = `m${runId}${Date.now()}`;
    expect((await post('/api/log', { marker, fail: true })).status).toBe(500);
    type Entry = { kind: string; level: string; message: string; path?: string; status?: number };
    const entries = await until(async () => {
      const logs = await callTool<{ entries: Entry[] }>(client, 'get_logs', { app: slug, since: '10m', limit: 200 });
      if (!logs.ok) return undefined;
      const mine = logs.data.entries;
      const found =
        mine.some((e) => e.kind === 'console' && e.message.includes(`log ${marker}`)) &&
        mine.some((e) => e.kind === 'exception' && e.message.includes(`boom ${marker}`)) &&
        mine.some((e) => e.kind === 'request' && e.path === '/api/log');
      return found ? mine : undefined;
    }, 120_000);
    expect(entries.find((e) => e.kind === 'console' && e.message.includes(`error ${marker}`))?.level).toBe('error');
    const failing = await callTool<{ entries: Entry[] }>(client, 'get_logs', {
      app: slug,
      since: '10m',
      kind: 'exception',
    });
    expect(failing.ok && failing.data.entries.every((e) => e.kind === 'exception')).toBe(true);
  });

  it(flow('F-MAIL-1', "the app's email arrives from hello@mail.<slug>.APPS_DOMAIN"), async () => {
    const to = testEmail('app-mail');
    const subject = `App mail ${runId}`;
    const since = Date.now();
    // The app's sending identity finishes verifying a few minutes after the app is created (MAIL-1.7).
    await until(
      async () => {
        const result = (await (await post('/api/send-email', { to, subject })).json()) as {
          ok: boolean;
          error?: { code: string };
        };
        if (result.ok) return true;
        expect(result.error?.code).toBe('tenant_not_ready');
        return undefined;
      },
      10 * 60_000,
      15_000,
    );
    const message = await waitForEmail({ to, since, match: (m) => m.subject === subject });
    expect(message.from).toBe(`hello@mail.${slug}.${e2eEnv().E2E_APPS_DOMAIN}`);
  });

  slowIt(flow('F-USG-1', 'traffic, a D1 query and an email show up in the app usage after collection'), async () => {
    const [app] = await platformQuery<{ id: string }>('SELECT id FROM apps WHERE slug = ?', [slug]);
    const wanted = ['requests', 'cpu_ms', 'd1_rows_read', 'emails', 'builds', 'deploys', 'artifact_bytes'];
    // Collection runs hourly and Cloudflare analytics lag a few minutes.
    const usage = await until(
      async () => {
        const rows = await platformQuery<{ metric: string; quantity: number }>(
          'SELECT metric, SUM(quantity) AS quantity FROM app_usage_daily WHERE app_id = ? GROUP BY metric',
          [app?.id],
        );
        const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r.quantity]));
        return wanted.every((m) => (byMetric[m] ?? 0) > 0) ? byMetric : undefined;
      },
      75 * 60_000,
      60_000,
    );
    expect(usage.emails).toBeGreaterThanOrEqual(1);
  });
});
