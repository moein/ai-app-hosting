import { newId, PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apps, appUsageDaily, deployments } from '../../src/db/schema';
import type { CloudflareAnalyticsClient } from '../../src/integrations/cloudflare-analytics';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { deleteApp } from '../../src/tools/apps/delete-app';
import { collectUsage, type UsageDeps } from '../../src/usage/collect';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

const TODAY = '2026-09-26'; // fakeClock starts at 2026-09-26T00:00Z
const YESTERDAY = '2026-09-25';

function fakeAnalytics(data: {
  assets?: Record<string, { hostname: string; requests: number }[]>;
  d1?: Record<string, { databaseId: string; rowsRead: number; rowsWritten: number }[]>;
  d1Storage?: Record<string, { databaseId: string; bytes: number }[]>;
}) {
  const failures = new Set<keyof CloudflareAnalyticsClient>();
  const calls: string[] = [];
  const fail = (method: keyof CloudflareAnalyticsClient) => {
    calls.push(method);
    if (failures.has(method)) throw new PlatformError('UPSTREAM_ERROR');
  };
  const client: CloudflareAnalyticsClient = {
    async assets(day) {
      fail('assets');
      return data.assets?.[day] ?? [];
    },
    async d1(day) {
      fail('d1');
      return data.d1?.[day] ?? [];
    },
    async d1Storage(day) {
      fail('d1Storage');
      return data.d1Storage?.[day] ?? [];
    },
  };
  return { client, failures, calls };
}

async function newApp(ctx: TestContext, name: string) {
  const created = await runTool(createApp, { name: `${name} ${Math.random().toString(36).slice(2, 7)}` }, ctx);
  const slug = (created.structuredContent as { slug: string }).slug;
  return (await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get()) as typeof apps.$inferSelect;
}

const deps = (ctx: TestContext, analytics: CloudflareAnalyticsClient): UsageDeps => ({
  db: ctx.db,
  analytics,
  github: ctx.github,
  appLogs: ctx.appLogs,
  clock: ctx.clock,
  metrics: ctx.metrics,
  logger: ctx.logger,
  appsDomain: 'motad.app',
});

async function usageOf(ctx: TestContext, appId: string) {
  const rows = await ctx.db.select().from(appUsageDaily).where(eq(appUsageDaily.appId, appId)).all();
  return Object.fromEntries(rows.map((r) => [`${r.day} ${r.metric}`, r.quantity]));
}

async function setup() {
  const ctx = testContext();
  ctx.clock.set(Date.UTC(2026, 8, 26, 12));
  await signIn(ctx);
  const live = await newApp(ctx, 'Live');
  const gone = await newApp(ctx, 'Gone');
  await runTool(deleteApp, { app: gone.slug, confirm_slug: gone.slug }, ctx);
  const analytics = fakeAnalytics({
    assets: { [TODAY]: [{ hostname: `${live.slug}.motad.app`, requests: 55 }] },
    d1: {
      [TODAY]: [
        { databaseId: live.d1DatabaseId as string, rowsRead: 1_000, rowsWritten: 20 },
        { databaseId: 'platform-db', rowsRead: 5, rowsWritten: 5 },
      ],
    },
    d1Storage: {
      [TODAY]: [
        { databaseId: live.d1DatabaseId as string, bytes: 65_536 },
        { databaseId: gone.d1DatabaseId as string, bytes: 12_288 },
      ],
    },
  });
  const now = ctx.clock.now();
  await ctx.db.update(apps).set({ liveDeploymentId: 'dep_live0000001' }).where(eq(apps.id, live.id));
  await ctx.appLogs(live.id).append(
    [
      { ts: now, kind: 'request', level: 'info', message: 'GET / 200', invocation_id: 'i' },
      { ts: now, kind: 'console', level: 'log', message: 'hello', invocation_id: 'i' },
    ],
    [
      ...Array.from({ length: 120 }, () => ({ ts: now, cpuMs: 2.5 })),
      ...Array.from({ length: 30 }, () => ({ ts: now - 86_400_000, cpuMs: 1 })),
    ],
  );
  const base = {
    appId: live.id,
    orgId: live.orgId,
    trigger: 'push' as const,
    commitSha: 'a'.repeat(40),
    createdAt: now - 3_600_000,
  };
  await ctx.db.insert(deployments).values([
    {
      ...base,
      id: newId('dep'),
      status: 'succeeded',
      runId: 7001,
      startedAt: now - 3_000_000,
      buildFinishedAt: now - 2_900_000,
      finishedAt: now - 2_800_000,
      artifactKey: `artifacts/${live.id}/a.tar.gz`,
      artifactBytes: 4_000,
    },
    { ...base, id: newId('dep'), status: 'failed', runId: 7002, startedAt: now - 1_000_000, finishedAt: now - 900_000 },
  ]);
  ctx.fakes.github.runTimings.set(7001, 90_000);
  ctx.fakes.github.runTimings.set(7002, 30_000);
  return { ctx, live, gone, analytics };
}

describe('collectUsage (USG-1)', () => {
  it('attributes every source to apps for today and yesterday', async () => {
    const { ctx, live, gone, analytics } = await setup();
    const result = await collectUsage(deps(ctx, analytics.client));
    expect(result.failed).toEqual([]);
    expect(await usageOf(ctx, live.id)).toEqual({
      [`${TODAY} requests`]: 120,
      [`${TODAY} cpu_ms`]: 300,
      [`${TODAY} asset_requests`]: 55,
      [`${TODAY} d1_rows_read`]: 1_000,
      [`${TODAY} d1_rows_written`]: 20,
      [`${TODAY} d1_storage_bytes`]: 65_536,
      [`${TODAY} log_entries`]: 2,
      [`${TODAY} log_bytes`]: 'GET / 200'.length + 'hello'.length,
      [`${TODAY} builds`]: 2,
      [`${TODAY} build_ms`]: 120_000,
      [`${TODAY} deploys`]: 1,
      [`${TODAY} artifact_bytes`]: 4_000,
      [`${YESTERDAY} requests`]: 30,
      [`${YESTERDAY} cpu_ms`]: 30,
    });
    // USG-1.6: a deleted app's database still costs storage.
    expect(await usageOf(ctx, gone.id)).toEqual({ [`${TODAY} d1_storage_bytes`]: 12_288 });
    expect(ctx.metrics.points.find((p) => p.event === 'usage_collected')?.fields).toMatchObject({ outcome: 'ok' });
  });

  it('is idempotent and never touches added metrics such as emails (USG-1.5)', async () => {
    const { ctx, live, analytics } = await setup();
    await ctx.db
      .insert(appUsageDaily)
      .values({ appId: live.id, orgId: live.orgId, day: TODAY, metric: 'emails', quantity: 4, updatedAt: 0 });
    await collectUsage(deps(ctx, analytics.client));
    const first = await usageOf(ctx, live.id);
    await collectUsage(deps(ctx, analytics.client));
    expect(await usageOf(ctx, live.id)).toEqual(first);
    expect(first[`${TODAY} emails`]).toBe(4);
    // Build timing is fetched once per deployment (USG-1.8).
    expect(ctx.fakes.github.timingCalls.sort()).toEqual([7001, 7002]);
  });

  it('keeps going when a source fails and records the failure (USG-1.7)', async () => {
    const { ctx, live, analytics } = await setup();
    analytics.failures.add('d1');
    const result = await collectUsage(deps(ctx, analytics.client));
    expect(result.failed).toEqual(['d1', 'd1']);
    const usage = await usageOf(ctx, live.id);
    expect(usage[`${TODAY} requests`]).toBe(120);
    expect(usage[`${TODAY} d1_rows_read`]).toBeUndefined();
    expect(ctx.metrics.points.filter((p) => p.event === 'usage_collection_failed').map((p) => p.fields.sub)).toEqual([
      'd1',
      'd1',
    ]);
  });

  it('only asks log buffers of apps that went live and can have had traffic', async () => {
    const { ctx, live, gone, analytics } = await setup();
    const asked: string[] = [];
    await collectUsage({
      ...deps(ctx, analytics.client),
      appLogs: (appId) => {
        asked.push(appId);
        return ctx.appLogs(appId);
      },
    });
    expect(asked).toContain(live.id); // earlier tests' live apps share this D1; `gone` never went live
    expect(asked).not.toContain(gone.id);
  });
});
