import { MAX_APPS_PER_ORG } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUniqueViolation } from '../../src/db/errors';
import { appSecrets, apps, deployments } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { getRoute } from '../../src/runtime/routes';
import { checkSlug } from '../../src/tools/apps/check-slug';
import { createApp } from '../../src/tools/apps/create-app';
import { deleteApp } from '../../src/tools/apps/delete-app';
import { getApp } from '../../src/tools/apps/get-app';
import { getUsage } from '../../src/tools/apps/get-usage';
import { listApps } from '../../src/tools/apps/list-apps';
import { retryProvisioning } from '../../src/tools/apps/retry-provisioning';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

type ErrorJson = { code: string; details?: Record<string, unknown> };
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => (r.structuredContent as { error: ErrorJson }).error;
const data = <T = Record<string, unknown>>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
const unique = () => Math.random().toString(36).slice(2, 8);

async function signedIn(overrides?: Parameters<typeof testContext>[0]) {
  const ctx = testContext(overrides);
  const identity = await signIn(ctx);
  return { ctx, ...identity };
}
const create = (ctx: TestContext, input: Record<string, unknown>) => runTool(createApp, input, ctx);

describe('create_app (APP-2, SLUG-4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a ready app with a slug generated from the name', async () => {
    const { ctx } = await signedIn();
    const name = `My Todo ${unique()}`;
    const app = data<{
      slug: string;
      url: string;
      provisioning: string;
      status: string;
      live_deployment: null;
      next_step: string;
    }>(await create(ctx, { name: `  ${name}  ` }));
    expect(app.slug).toBe(name.toLowerCase().replace(/ /g, '-'));
    expect(app).toMatchObject({ provisioning: 'ready', status: 'active', live_deployment: null });
    expect(app.url).toBe(`https://${app.slug}.motad.app`);
    expect(app.next_step).toContain('write_files');
  });

  it('uses a requested slug, and rejects invalid or taken ones with a suggestion (SLUG-4.1, SLUG-4.2)', async () => {
    const { ctx } = await signedIn();
    const slug = `pick-${unique()}`;
    expect(data<{ slug: string }>(await create(ctx, { name: 'Picked', slug })).slug).toBe(slug);

    const taken = errorOf(await create(ctx, { name: 'Again', slug }));
    expect(taken.code).toBe('SLUG_UNAVAILABLE');
    expect(String(taken.details?.suggestion)).toMatch(new RegExp(`^${slug}-[0-9a-z]{4}$`));

    const invalid = errorOf(await create(ctx, { name: 'Bad', slug: 'Bad--Slug' }));
    expect(invalid).toMatchObject({ code: 'SLUG_INVALID', details: { reason: 'invalid_chars' } });
    expect(invalid.details?.suggestion).toBe('bad-slug');
  });

  it('validates the name (APP-2.1)', async () => {
    const { ctx } = await signedIn();
    for (const name of ['', '   ', 'x'.repeat(61), 'bad\u0007name']) {
      expect(errorOf(await create(ctx, { name })).code).toBe('NAME_INVALID');
    }
  });

  it('enforces the per-org app limit (APP-2.8)', async () => {
    const { ctx } = await signedIn();
    for (let i = 0; i < MAX_APPS_PER_ORG; i++) data(await create(ctx, { name: `Quota ${unique()}` }));
    expect(errorOf(await create(ctx, { name: 'One too many' }))).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'apps', max: MAX_APPS_PER_ORG },
    });
  });

  it('returns pending with a next step when setup takes longer than the wait (APP-2.4)', async () => {
    const { ctx } = await signedIn({ provisioner: { start: async () => {} } });
    ctx.sleep = async (ms) => void ctx.clock.advance(ms);
    const app = data<{ provisioning: string; next_step: string }>(await create(ctx, { name: `Slow ${unique()}` }));
    expect(app.provisioning).toBe('pending');
    expect(app.next_step).toContain('get_app');
  });

  it('never writes application code into the repo (APP-2.7)', async () => {
    const { ctx } = await signedIn();
    const { slug } = data<{ slug: string }>(await create(ctx, { name: `Empty ${unique()}` }));
    expect(Object.keys(ctx.fakes.github.mainFiles(`dev-${slug}`)).sort()).toEqual([
      '.github/workflows/deploy.yml',
      'platform.json',
    ]);
  });
});

describe('retry_provisioning (APP-2.6)', () => {
  it('reruns setup only for failed apps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = await signedIn();
    ctx.fakes.cloudflare.failNext('createD1', new Error('boom'));
    const failed = data<{ slug: string; provisioning: string }>(await create(ctx, { name: `Flaky ${unique()}` }));
    expect(failed.provisioning).toBe('failed');
    expect(
      data<{ provisioning_error: string }>(await runTool(getApp, { app: failed.slug }, ctx)).provisioning_error,
    ).toBe('INTERNAL');

    ctx.fakes.cloudflare.clearFailures();
    expect(
      data<{ provisioning: string }>(await runTool(retryProvisioning, { app: failed.slug }, ctx)).provisioning,
    ).toBe('ready');
    expect(errorOf(await runTool(retryProvisioning, { app: failed.slug }, ctx)).code).toBe('CONFLICT');
  });
});

describe('list_apps / get_app / get_usage (APP-3, APP-5.4)', () => {
  it('lists active apps newest first and shows details', async () => {
    const { ctx } = await signedIn();
    const first = data<{ slug: string }>(await create(ctx, { name: `First ${unique()}` }));
    ctx.clock.advance(1_000);
    const second = data<{ slug: string }>(await create(ctx, { name: `Second ${unique()}` }));
    const { apps: listed } = data<{ apps: { slug: string }[] }>(await runTool(listApps, {}, ctx));
    expect(listed.map((a) => a.slug)).toEqual([second.slug, first.slug]);

    const detail = data<{ latest_deployment: null; repo: { head_commit_sha: string | null } }>(
      await runTool(getApp, { app: first.slug }, ctx),
    );
    expect(detail.latest_deployment).toBeNull();
    expect(detail.repo.head_commit_sha).toMatch(/^[0-9a-f]{40}$/);

    expect(data(await runTool(getUsage, {}, ctx))).toMatchObject({
      apps: { used: 2, max: MAX_APPS_PER_ORG },
      deploys_today: { used: 0 },
      emails_today: { used: 0 },
    });
  });

  it("hides other orgs' apps as NOT_FOUND and flags unready/deleted apps (APP-3.3 – 3.5)", async () => {
    const owner = await signedIn();
    const { slug } = data<{ slug: string }>(await create(owner.ctx, { name: `Private ${unique()}` }));
    const stranger = await signedIn();
    expect(errorOf(await runTool(getApp, { app: slug }, stranger.ctx)).code).toBe('NOT_FOUND');
    expect(errorOf(await runTool(retryProvisioning, { app: `nope-${unique()}` }, owner.ctx)).code).toBe('NOT_FOUND');
  });
});

describe('delete_app (APP-4)', () => {
  it('deletes only the Worker, keeps code/database/history, and keeps the slug taken', async () => {
    const { ctx } = await signedIn();
    const { slug } = data<{ slug: string }>(await create(ctx, { name: `Doomed ${unique()}` }));
    const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
    await ctx.db.insert(deployments).values({
      id: `dep_${unique()}xxxxx`,
      appId: app?.id as string,
      orgId: app?.orgId as string,
      trigger: 'push',
      commitSha: 'a'.repeat(40),
      status: 'building',
      createdAt: ctx.clock.now(),
    });
    await ctx.db.insert(appSecrets).values({ appId: app?.id as string, name: 'KEY', createdAt: 0, updatedAt: 0 });

    const wrong = errorOf(await runTool(deleteApp, { app: slug, confirm_slug: 'other' }, ctx));
    expect(wrong.code).toBe('INVALID_INPUT');
    expect(ctx.fakes.cloudflare.scripts.has(slug)).toBe(true);

    const result = data(await runTool(deleteApp, { app: slug, confirm_slug: slug }, ctx));
    expect(result).toEqual({ slug, status: 'deleted', kept: ['source code', 'database', 'deployment history'] });
    expect(ctx.fakes.cloudflare.scripts.has(slug)).toBe(false);
    expect(ctx.fakes.cloudflare.callsTo('deleteD1')).toHaveLength(0);
    expect(ctx.fakes.github.repos.has(`dev-${slug}`)).toBe(true);
    expect(await getRoute(ctx.routes, slug)).toBeNull();
    expect(
      await ctx.db
        .select()
        .from(appSecrets)
        .where(eq(appSecrets.appId, app?.id as string))
        .all(),
    ).toEqual([]);
    const dep = await ctx.db
      .select()
      .from(deployments)
      .where(eq(deployments.appId, app?.id as string))
      .get();
    expect(dep?.status).toBe('cancelled');

    expect(data<{ status: string }>(await runTool(getApp, { app: slug }, ctx)).status).toBe('deleted');
    expect(data<{ apps: unknown[] }>(await runTool(listApps, {}, ctx)).apps).toEqual([]);
    expect(errorOf(await runTool(deleteApp, { app: slug, confirm_slug: slug }, ctx)).code).toBe('APP_DELETED');
    expect(errorOf(await create(ctx, { name: 'Reuse', slug })).code).toBe('SLUG_UNAVAILABLE');
  });

  it('succeeds when the Worker is already gone (APP-4.6)', async () => {
    const { ctx } = await signedIn();
    const { slug } = data<{ slug: string }>(await create(ctx, { name: `Gone ${unique()}` }));
    ctx.fakes.cloudflare.scripts.delete(slug);
    expect(data<{ status: string }>(await runTool(deleteApp, { app: slug, confirm_slug: slug }, ctx)).status).toBe(
      'deleted',
    );
  });
});

describe('check_slug (SLUG-4.3) and slug uniqueness (SLUG-3)', () => {
  it('reports valid/available, taken with suggestion, and invalid with reason', async () => {
    const { ctx } = await signedIn();
    const free = `free-${unique()}`;
    expect(data(await runTool(checkSlug, { slug: free }, ctx))).toEqual({ slug: free, valid: true, available: true });
    const { slug } = data<{ slug: string }>(await create(ctx, { name: `Taken ${unique()}` }));
    expect(data(await runTool(checkSlug, { slug }, ctx))).toMatchObject({
      valid: true,
      available: false,
      suggestion: expect.stringMatching(/-[0-9a-z]{4}$/),
    });
    expect(data(await runTool(checkSlug, { slug: 'api' }, ctx))).toMatchObject({
      valid: false,
      reason: 'reserved',
      suggestion: expect.stringMatching(/^api-/),
    });
  });

  it('enforces uniqueness in the database and lets concurrent generated slugs both succeed', async () => {
    const { ctx } = await signedIn();
    const name = `Race ${unique()}`;
    const [a, b] = await Promise.all([create(ctx, { name }), create(testContext({ ...ctx }), { name })]);
    const slugs = [data<{ slug: string }>(a).slug, data<{ slug: string }>(b).slug];
    expect(new Set(slugs).size).toBe(2);
    const row = await ctx.db
      .select()
      .from(apps)
      .where(eq(apps.slug, slugs[0] as string))
      .get();
    const duplicate = await ctx.db
      .insert(apps)
      .values({ ...(row as typeof apps.$inferInsert), id: `app_${unique()}xxxxx` })
      .catch((error: unknown) => error);
    expect(isUniqueViolation(duplicate, 'apps.slug')).toBe(true);
  });
});
