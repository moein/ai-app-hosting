import { renderPlatformJson } from '@repo/app-contract';
import { PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertApp } from '../../src/apps/insert';
import { runProvisioning } from '../../src/apps/provision';
import { apps } from '../../src/db/schema';
import { getRoute } from '../../src/runtime/routes';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

const deps = (ctx: TestContext) => ({
  db: ctx.db,
  cloudflare: ctx.cloudflare,
  github: ctx.github,
  routes: ctx.routes,
  clock: ctx.clock,
  logger: ctx.logger,
  metrics: ctx.metrics,
  emailJobs: ctx.emailJobs,
  apiOrigin: 'https://api.test',
  environment: 'dev' as const,
});

async function newApp(name = `Prov ${Math.random().toString(36).slice(2, 8)}`) {
  const ctx = testContext();
  await signIn(ctx);
  const app = await insertApp(ctx, { name });
  return { ctx, app };
}

describe('ProvisionApp steps (APP-2.3, APP-2.5, APP-2.6, SRC-1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates D1, the repo with only managed files, the placeholder script and route, then marks ready', async () => {
    const { ctx, app } = await newApp();
    await runProvisioning(deps(ctx), app.id);
    const row = await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get();
    expect(row).toMatchObject({
      provisioning: 'ready',
      d1DatabaseId: 'd1-1',
      repoName: `dev-${app.slug}`,
      r2BucketName: `app-${app.slug}-dev`,
    });
    expect(row?.repoId).toBeGreaterThan(0);
    expect(ctx.fakes.cloudflare.databases.get(`app-${app.slug}-dev`)).toBe('d1-1');
    expect(ctx.fakes.cloudflare.buckets.has(`app-${app.slug}-dev`)).toBe(true);

    const files = ctx.fakes.github.mainFiles(`dev-${app.slug}`);
    expect(Object.keys(files).sort()).toEqual(['.github/workflows/deploy.yml', 'platform.json']);
    expect(JSON.parse(files['platform.json'] as string)).toMatchObject({ app: app.slug, api: 'https://api.test' });
    expect(files['.github/workflows/deploy.yml']).toContain('API: https://api.test');
    const repo = ctx.fakes.github.repos.get(`dev-${app.slug}`);
    expect([...(repo?.commits.values() ?? [])].every((c) => c.message.includes('[skip ci]'))).toBe(true);

    const script = ctx.fakes.cloudflare.scripts.get(app.slug);
    expect(script?.metadata.bindings).toEqual([]);
    expect(await getRoute(ctx.routes, app.slug)).toEqual({
      appId: app.id,
      scriptName: app.slug,
      state: 'not_deployed',
    });
    // MAIL-1.5: the app's email identity is handed to the email worker.
    expect(ctx.emailJobs.messages).toContainEqual({ type: 'app.provision_email_identity', appId: app.id });
  });

  it('is idempotent: a second run creates nothing new', async () => {
    const { ctx, app } = await newApp();
    await runProvisioning(deps(ctx), app.id);
    const commits = ctx.fakes.github.repos.get(`dev-${app.slug}`)?.commits.size;
    await runProvisioning(deps(ctx), app.id);
    expect(ctx.fakes.cloudflare.callsTo('createD1')).toHaveLength(1);
    expect(ctx.fakes.cloudflare.callsTo('createR2')).toHaveLength(1);
    expect(ctx.fakes.github.repos.get(`dev-${app.slug}`)?.commits.size).toBe(commits);
  });

  it('the r2 step finds an existing bucket instead of recreating it (APP-2.6, retry_provisioning)', async () => {
    const { ctx, app } = await newApp();
    const bucketName = `app-${app.slug}-dev`;
    await ctx.cloudflare.createR2(bucketName);
    await runProvisioning(deps(ctx), app.id);
    expect(ctx.fakes.cloudflare.callsTo('createR2')).toHaveLength(1); // only the pre-seeded call above
    expect(ctx.fakes.cloudflare.callsTo('findR2').length).toBeGreaterThan(0);
    expect((await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get())?.r2BucketName).toBe(bucketName);
  });

  it('reuses an existing repo that belongs to the app, and refuses one that does not (SRC-1.3)', async () => {
    const { ctx, app } = await newApp();
    await ctx.github.createRepo(`dev-${app.slug}`, 'x');
    await ctx.github.putFileOnEmptyRepo(
      `dev-${app.slug}`,
      'platform.json',
      renderPlatformJson({ slug: app.slug, apiOrigin: 'x' }),
      'init',
    );
    await runProvisioning(deps(ctx), app.id);
    expect((await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get())?.provisioning).toBe('ready');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = await newApp();
    await other.ctx.github.createRepo(`dev-${other.app.slug}`, 'x');
    await other.ctx.github.putFileOnEmptyRepo(
      `dev-${other.app.slug}`,
      'platform.json',
      renderPlatformJson({ slug: 'someone-else', apiOrigin: 'x' }),
      'init',
    );
    await expect(runProvisioning(deps(other.ctx), other.app.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const row = await other.ctx.db.select().from(apps).where(eq(apps.id, other.app.id)).get();
    expect(row).toMatchObject({ provisioning: 'failed', provisioningError: 'CONFLICT' });
  });

  it('marks the app failed with the error code when a step keeps failing (APP-2.5)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, app } = await newApp();
    ctx.fakes.cloudflare.failNext('createD1', new PlatformError('UPSTREAM_ERROR'));
    await expect(runProvisioning(deps(ctx), app.id)).rejects.toBeInstanceOf(PlatformError);
    expect(ctx.metrics.points).toContainEqual({
      event: 'provisioning_failed',
      fields: expect.objectContaining({ appId: app.id, sub: 'app', errorCode: 'UPSTREAM_ERROR' }),
    });
    expect(await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get()).toMatchObject({
      provisioning: 'failed',
      provisioningError: 'UPSTREAM_ERROR',
    });
  });
});
