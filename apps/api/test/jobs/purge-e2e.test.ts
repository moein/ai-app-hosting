import { E2E_PURGE_AFTER_MS } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apps, organizations, users } from '../../src/db/schema';
import { e2eEmailPattern, type PurgeDeps, purgeE2eUsers } from '../../src/jobs/purge-e2e';
import { runTool } from '../../src/mcp/pipeline';
import { getRoute } from '../../src/runtime/routes';
import { createApp } from '../../src/tools/apps/create-app';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

const INBOX = 'e2e@motad.app';

const purgeDeps = (ctx: TestContext): PurgeDeps => ({
  db: ctx.db,
  cloudflare: ctx.cloudflare,
  github: ctx.github,
  routes: ctx.routes,
  artifacts: ctx.artifacts,
  appLogs: ctx.appLogs,
  emailJobs: ctx.emailJobs,
  appsDomain: 'motad.app',
  logger: ctx.logger,
});

async function userWithApp(email: string, ageMs: number) {
  const ctx = testContext();
  const { userId, orgId } = await signIn(ctx, { email });
  const created = await runTool(createApp, { name: `Purge ${Math.random().toString(36).slice(2, 8)}` }, ctx);
  const slug = (created.structuredContent as { slug: string }).slug;
  const app = (await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get()) as typeof apps.$inferSelect;
  await ctx.db
    .update(users)
    .set({ createdAt: ctx.clock.now() - ageMs })
    .where(eq(users.id, userId));
  await ctx.artifacts.put(`artifacts/${app.id}/dep_1.tar.gz`, 'x');
  await ctx
    .appLogs(app.id)
    .append([{ ts: ctx.clock.now(), kind: 'console', level: 'log', message: 'hi', invocation_id: 'i' }]);
  return { ctx, userId, orgId, app };
}

const exists = async (ctx: TestContext, userId: string) =>
  (await ctx.db.select().from(users).where(eq(users.id, userId)).get()) !== undefined;

describe('dev e2e purge (E2E-4.2, E2E-4.3)', () => {
  it('builds an escaped LIKE pattern from the inbox address', () => {
    expect(e2eEmailPattern('e2e@motad.app')).toBe('e2e+%@motad.app');
    expect(e2eEmailPattern('e_2%e@x.io')).toBe('e\\_2\\%e+%@x.io');
    expect(e2eEmailPattern('not-an-address')).toBeNull();
  });

  it('removes old e2e users with every resource, and only them', async () => {
    const run = Date.now().toString(36);
    const old = await userWithApp(`e2e+${run}-old@motad.app`, E2E_PURGE_AFTER_MS + 1_000);
    const fresh = await userWithApp(`e2e+${run}-fresh@motad.app`, 1_000);
    const real = await userWithApp(`someone-${run}@example.com`, E2E_PURGE_AFTER_MS * 100);
    const { ctx, app } = old;

    const result = await purgeE2eUsers(purgeDeps(ctx), {
      environment: 'dev',
      inboxAddress: INBOX,
      now: ctx.clock.now(),
    });
    expect(result).toMatchObject({ users: 1, apps: 1, failed: 0 });

    expect(await exists(ctx, old.userId)).toBe(false);
    expect(await ctx.db.select().from(organizations).where(eq(organizations.id, old.orgId)).get()).toBeUndefined();
    expect(await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get()).toBeUndefined();
    expect(ctx.fakes.cloudflare.scripts.has(app.scriptName)).toBe(false);
    expect([...ctx.fakes.cloudflare.databases.values()]).not.toContain(app.d1DatabaseId);
    expect(ctx.fakes.github.repos.has(app.repoName)).toBe(false);
    expect(await getRoute(ctx.routes, app.slug)).toBeNull();
    expect((await ctx.artifacts.list({ prefix: `artifacts/${app.id}/` })).objects).toEqual([]);
    expect((await ctx.appLogs(app.id).query({ since: 0, until: Number.MAX_SAFE_INTEGER, limit: 10 })).entries).toEqual(
      [],
    );
    expect(ctx.emailJobs.messages).toContainEqual({
      type: 'org.purge_email',
      orgId: old.orgId,
      domains: [`mail.${app.slug}.motad.app`],
    });

    expect(await exists(ctx, fresh.userId)).toBe(true);
    expect(await exists(ctx, real.userId)).toBe(true);
  });

  it('keeps the rows when an external deletion fails, so the next run retries', async () => {
    const { ctx, userId } = await userWithApp(
      `e2e+${Date.now().toString(36)}-retry@motad.app`,
      E2E_PURGE_AFTER_MS + 1_000,
    );
    ctx.fakes.cloudflare.failNext('deleteScript', new Error('cloudflare down'));
    const result = await purgeE2eUsers(purgeDeps(ctx), {
      environment: 'dev',
      inboxAddress: INBOX,
      now: ctx.clock.now(),
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await exists(ctx, userId)).toBe(true);

    ctx.fakes.cloudflare.clearFailures();
    await purgeE2eUsers(purgeDeps(ctx), { environment: 'dev', inboxAddress: INBOX, now: ctx.clock.now() });
    expect(await exists(ctx, userId)).toBe(false);
  });

  it('never runs in prod or without an inbox address', async () => {
    const { ctx, userId } = await userWithApp(`e2e+${Date.now().toString(36)}-prod@motad.app`, E2E_PURGE_AFTER_MS * 10);
    for (const options of [
      { environment: 'prod', inboxAddress: INBOX },
      { environment: 'dev', inboxAddress: undefined },
    ]) {
      expect(await purgeE2eUsers(purgeDeps(ctx), { ...options, now: ctx.clock.now() })).toEqual({
        users: 0,
        apps: 0,
        failed: 0,
      });
    }
    expect(await exists(ctx, userId)).toBe(true);
    expect(ctx.fakes.cloudflare.callsTo('deleteScript')).toHaveLength(0);
  });
});
