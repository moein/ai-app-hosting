import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertApp } from '../../src/apps/insert';
import { runDeployment } from '../../src/builds/deploy';
import { apps, deployments } from '../../src/db/schema';
import { getRoute } from '../../src/runtime/routes';
import { signIn, type TestContext, testContext } from '../mcp/helpers';
import { artifactFiles, gzip, makeTar } from './tar';

async function setup(files = artifactFiles()) {
  const ctx = testContext();
  await signIn(ctx);
  const app = await insertApp(ctx, { name: `Deploy ${Math.random().toString(36).slice(2, 8)}` });
  await ctx.db
    .update(apps)
    .set({ provisioning: 'ready', d1DatabaseId: 'db-123', repoId: 1 })
    .where(eq(apps.id, app.id));
  const deploymentId = `dep_${Math.random().toString(36).slice(2, 13)}`;
  const key = `artifacts/${app.id}/${deploymentId}.tar.gz`;
  await ctx.artifacts.put(key, await gzip(makeTar(files)));
  await ctx.db.insert(deployments).values({
    id: deploymentId,
    appId: app.id,
    orgId: app.orgId,
    trigger: 'push',
    commitSha: 'a'.repeat(40),
    status: 'deploying',
    artifactKey: key,
    createdAt: ctx.clock.now(),
  });
  return { ctx, app, deploymentId, key };
}

const deps = (ctx: TestContext) => ({
  db: ctx.db,
  cloudflare: ctx.cloudflare,
  routes: ctx.routes,
  artifacts: ctx.artifacts,
  clock: ctx.clock,
  logger: ctx.logger,
  metrics: ctx.metrics,
  environment: 'dev' as const,
});

describe('DeployApp (DEP-2.9 – 2.11)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads assets and the script with exactly the platform bindings, then goes live', async () => {
    const { ctx, app, deploymentId, key } = await setup(
      artifactFiles({
        './dist/app/wrangler.json': JSON.stringify({
          main: 'index.js',
          compatibility_date: '2026-08-22',
          assets: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
          vars: { GREETING: 'hi' },
          kv_namespaces: [{ binding: 'SNEAKY', id: 'x' }],
          services: [{ binding: 'PLATFORM', service: 'api-dev' }],
        }),
      }),
    );
    await runDeployment(deps(ctx), { deploymentId, artifactKey: key, skipMigrations: false });

    const [name, metadata, modules] = (ctx.fakes.cloudflare.callsTo('uploadScript')[0]?.args ?? []) as [
      string,
      Record<string, unknown>,
      { name: string }[],
    ];
    expect(name).toBe(app.slug);
    expect(metadata).toMatchObject({
      main_module: 'index.js',
      keep_bindings: ['secret_text'],
      tail_consumers: [{ service: 'tail-dev' }],
      tags: [app.id, app.orgId],
      assets: {
        jwt: 'completion-jwt',
        config: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
      },
    });
    expect((metadata.bindings as { name: string }[]).map((b) => b.name)).toEqual(['DB', 'ASSETS', 'EMAIL', 'GREETING']);
    expect(modules.map((m) => m.name).sort()).toEqual(['chunk.js', 'index.js']);

    const manifest = ctx.fakes.cloudflare.callsTo('createAssetsUploadSession')[0]?.args[1] as Record<
      string,
      { hash: string }
    >;
    expect(Object.keys(manifest).sort()).toEqual(['/assets/app.js', '/index.html']);
    expect(Object.values(manifest).every((entry) => /^[0-9a-f]{32}$/.test(entry.hash))).toBe(true);

    expect((await ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get())?.status).toBe(
      'succeeded',
    );
    expect((await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get())?.liveDeploymentId).toBe(deploymentId);
    expect(await getRoute(ctx.routes, app.slug)).toEqual({ appId: app.id, scriptName: app.slug, state: 'live' });
    expect(ctx.fakes.cloudflare.callsTo('d1Query').length).toBeGreaterThan(0);
  });

  it('skips migrations for rollbacks', async () => {
    const { ctx, deploymentId, key } = await setup();
    await runDeployment(deps(ctx), { deploymentId, artifactKey: key, skipMigrations: true });
    expect(ctx.fakes.cloudflare.callsTo('d1Query')).toHaveLength(0);
  });

  it('fails with DEPLOY_FAILED when publishing fails, leaving the previous live deployment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, app, deploymentId, key } = await setup();
    await ctx.db.update(apps).set({ liveDeploymentId: 'dep_previous' }).where(eq(apps.id, app.id));
    ctx.fakes.cloudflare.failNext('uploadScript', new Error('503'));
    await runDeployment(deps(ctx), { deploymentId, artifactKey: key, skipMigrations: false });
    expect(await ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()).toMatchObject({
      status: 'failed',
      errorCode: 'DEPLOY_FAILED',
    });
    expect((await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get())?.liveDeploymentId).toBe('dep_previous');
  });

  it('fails with MIGRATION_FAILED before uploading anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, deploymentId, key } = await setup(artifactFiles({ './migrations/0001_init.sql': 'CREATE TABLE (' }));
    await runDeployment(deps(ctx), { deploymentId, artifactKey: key, skipMigrations: false });
    const row = await ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'MIGRATION_FAILED' });
    expect(JSON.parse(row?.errorDetails ?? '{}')).toMatchObject({ file: '0001_init.sql' });
    expect(ctx.fakes.cloudflare.callsTo('uploadScript')).toHaveLength(0);
  });
});
