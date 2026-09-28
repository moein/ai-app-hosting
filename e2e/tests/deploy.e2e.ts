import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createReadyApp, deleteApps, waitForStatus } from '../src/apps';
import { logIn } from '../src/auth';
import { isImplemented } from '../src/catalog';
import { type DeploymentView, fixtureFiles, waitForDeployment, writeAndDeploy } from '../src/deploy';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { appName, testEmail } from '../src/run';

let client: Client;
let slug = '';
let first: DeploymentView | undefined;

const health = async () => (await waitForStatus(`${appUrl(slug)}/api/health`, 200)).json();

// Needs a live deployment (Workers Paid plan on the account); runs once F-DEP-1 is marked implemented.
describe.skipIf(!isImplemented('F-DEP-1'))('build and deploy', () => {
  beforeAll(async () => {
    client = await connect();
    await logIn(client, testEmail('deploy'));
    slug = (await createReadyApp(client, appName('deploy'))).slug;
  });

  afterAll(async () => {
    await deleteApps(client, [slug]);
    await client.close();
  });

  it(flow('F-DEP-1', 'a contract-compliant app builds on GitHub Actions and goes live with its database'), async () => {
    first = await writeAndDeploy(client, slug, fixtureFiles(), 'Contract app');
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'live', error: null, url: appUrl(slug) });
    expect(await health()).toEqual({ ok: true, notes: 1 });
    const page = await waitForStatus(appUrl(slug), 200);
    expect(await page.text()).toContain('<div id="root">');
  });

  it(
    flow('F-DEP-5', 'a new migration is applied; editing an applied one fails and the previous version stays live'),
    async () => {
      const added = await writeAndDeploy(
        client,
        slug,
        [{ path: 'migrations/0002_second_note.sql', content: "INSERT INTO notes (body) VALUES ('second');\n" }],
        'Add a note',
      );
      expect(added, JSON.stringify(added)).toMatchObject({ status: 'live' });
      expect(await health()).toEqual({ ok: true, notes: 2 });

      const original = fixtureFiles().find((f) => f.path === 'migrations/0001_init.sql')?.content ?? '';
      const edited = await writeAndDeploy(
        client,
        slug,
        [{ path: 'migrations/0001_init.sql', content: `${original}\n-- edited after it was applied\n` }],
        'Edit an applied migration',
      );
      expect(edited, JSON.stringify(edited)).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_FAILED' } });
      expect(await health()).toEqual({ ok: true, notes: 2 });
    },
  );

  it(flow('F-DEP-4', 'redeploy builds main again; rollback serves an earlier deployment'), async () => {
    const restored = await writeAndDeploy(
      client,
      slug,
      fixtureFiles().filter((f) => f.path === 'migrations/0001_init.sql'),
      'Restore the applied migration',
    );
    expect(restored.status, JSON.stringify(restored)).toBe('live');

    const redeploy = await callTool<DeploymentView>(client, 'redeploy', { app: slug });
    expect(redeploy.ok, JSON.stringify(redeploy)).toBe(true);
    if (!redeploy.ok) return;
    const rebuilt = await waitForDeployment(client, slug, redeploy.data.id);
    expect(rebuilt, JSON.stringify(rebuilt)).toMatchObject({ status: 'live' });

    const rollback = await callTool<DeploymentView>(client, 'rollback', { app: slug, deployment: first?.id });
    expect(rollback.ok, JSON.stringify(rollback)).toBe(true);
    if (!rollback.ok) return;
    const restoredOld = await waitForDeployment(client, slug, rollback.data.id);
    expect(restoredOld, JSON.stringify(restoredOld)).toMatchObject({ status: 'live', commit_sha: first?.commit_sha });
    expect(await health()).toEqual({ ok: true, notes: 2 }); // code rolls back, data doesn't
  });
});
