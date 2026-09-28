import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppSummary, appUrl, createReadyApp, deleteApps, waitForStatus } from '../src/apps';
import { logIn } from '../src/auth';
import { e2eEnv } from '../src/env';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { appName, runId, testEmail } from '../src/run';

let client: Client;
const created: string[] = [];

describe('apps', () => {
  beforeAll(async () => {
    client = await connect();
    await logIn(client, testEmail('apps'));
  });

  afterAll(async () => {
    await deleteApps(client, created);
    await client.close();
  });

  it(
    flow(['F-APP-1', 'F-APP-4'], 'create an app: ready, listed, "being built" page at its URL, counted in usage'),
    async () => {
      const app = await createReadyApp(client, appName(1));
      created.push(app.slug);
      expect(app.slug).toBe(`e2e-${runId}-1`);
      expect(app.url).toBe(appUrl(app.slug));

      const list = await callTool<{ apps: AppSummary[] }>(client, 'list_apps');
      expect(list.ok && list.data.apps.map((a) => a.slug)).toContain(app.slug);
      const detail = await callTool<{ repo: { head_commit_sha: string | null }; latest_deployment: unknown }>(
        client,
        'get_app',
        {
          app: app.slug,
        },
      );
      expect(detail.ok && detail.data.repo.head_commit_sha).toMatch(/^[0-9a-f]{40}$/);

      const page = await waitForStatus(app.url, 503);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain('This app is being built');

      const usage = await callTool<{ apps: { used: number; max: number } }>(client, 'get_usage');
      expect(usage.ok && usage.data.apps.used).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    flow(['F-APP-2', 'F-SLUG-1'], 'slugs: check_slug states, and a taken slug is refused with a suggestion'),
    async () => {
      const slug = `e2e-${runId}-slug`;
      const free = await callTool<{ valid: boolean; available: boolean }>(client, 'check_slug', { slug });
      expect(free.ok && free.data).toMatchObject({ valid: true, available: true });

      const app = await createReadyApp(client, appName('slug'), slug);
      created.push(app.slug);
      const taken = await callTool<{ available: boolean; suggestion: string }>(client, 'check_slug', { slug });
      expect(taken.ok && taken.data).toMatchObject({ valid: true, available: false });

      const reserved = await callTool<{ valid: boolean; reason: string }>(client, 'check_slug', { slug: 'www' });
      expect(reserved.ok && reserved.data).toMatchObject({ valid: false, reason: 'reserved' });
      const invalid = await callTool<{ valid: boolean; reason: string }>(client, 'check_slug', { slug: 'Bad_Slug' });
      expect(invalid.ok && invalid.data).toMatchObject({ valid: false, reason: 'invalid_chars' });

      const duplicate = await callTool(client, 'create_app', { name: 'Duplicate', slug });
      expect(!duplicate.ok && duplicate.error.code).toBe('SLUG_UNAVAILABLE');
      if (!duplicate.ok) expect(String(duplicate.error.details?.suggestion)).toMatch(new RegExp(`^${slug}-`));
    },
  );

  it(flow('F-APP-3', 'delete an app: its URL goes 404, it shows as deleted, and its slug stays taken'), async () => {
    const app = await createReadyApp(client, appName('delete'));
    await waitForStatus(app.url, 503);
    const deleted = await callTool(client, 'delete_app', { app: app.slug, confirm_slug: app.slug });
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);

    expect((await waitForStatus(app.url, 404)).status).toBe(404);
    const detail = await callTool<{ status: string }>(client, 'get_app', { app: app.slug });
    expect(detail.ok && detail.data.status).toBe('deleted');
    const slug = await callTool<{ available: boolean }>(client, 'check_slug', { slug: app.slug });
    expect(slug.ok && slug.data.available).toBe(false);
  });

  it(flow('F-RUN-3', 'unknown apps get the 404 page; www redirects to the homepage'), async () => {
    const domain = e2eEnv().E2E_APPS_DOMAIN;
    const missing = await fetch(`https://e2e-${runId}-missing.${domain}/`, { redirect: 'manual' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("There's no app at this address");
    const www = await fetch(`https://www.${domain}/`, { redirect: 'manual' });
    expect(www.status).toBe(302);
    expect(www.headers.get('location')).toBe(`https://${domain}/`);
  });
});
