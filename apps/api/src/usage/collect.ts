import {
  type AppLogsRpc,
  type Clock,
  type Logger,
  type Metrics,
  USAGE_METRICS,
  type UsageMetric,
  utcDay,
} from '@repo/shared';
import { and, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apps, appUsageDaily, deployments } from '../db/schema';
import type { CloudflareAnalyticsClient } from '../integrations/cloudflare-analytics';
import type { GitHubClient } from '../integrations/github';

const DAY_MS = 86_400_000;
const TIMING_BATCH = 50;
const ROWS_PER_STATEMENT = 16; // 6 bound values per row, D1 allows ≤ 100 per statement

export type UsageDeps = {
  db: Db;
  analytics: CloudflareAnalyticsClient;
  github: GitHubClient;
  appLogs(appId: string): AppLogsRpc;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  dispatchNamespace: string;
  appsDomain: string;
};

type Source = 'workers' | 'assets' | 'd1' | 'd1_storage' | 'logs' | 'builds' | 'github';
type AppRef = {
  id: string;
  orgId: string;
  slug: string;
  scriptName: string;
  d1DatabaseId: string | null;
  repoName: string;
};

/** Totals per `<appId>|<day>` and metric. */
class Totals {
  readonly values = new Map<string, Map<UsageMetric, number>>();
  add(appId: string, day: string, metric: UsageMetric, quantity: number) {
    if (!(quantity > 0)) return;
    const key = `${appId}|${day}`;
    const metrics = this.values.get(key) ?? new Map<UsageMetric, number>();
    metrics.set(metric, (metrics.get(metric) ?? 0) + quantity);
    this.values.set(key, metrics);
  }
  has(appId: string, day: string, metric: UsageMetric) {
    return (this.values.get(`${appId}|${day}`)?.get(metric) ?? 0) > 0;
  }
}

/** USG-1.8: billable build time for recently finished deployments, fetched once each. */
async function backfillBuildTimes(deps: UsageDeps, byId: Map<string, AppRef>, now: number) {
  const pending = await deps.db
    .select({ id: deployments.id, appId: deployments.appId, runId: deployments.runId })
    .from(deployments)
    .where(
      and(
        isNotNull(deployments.runId),
        isNull(deployments.buildBillableMs),
        inArray(deployments.status, ['succeeded', 'failed', 'cancelled']),
        gte(deployments.finishedAt, now - 2 * DAY_MS),
      ),
    )
    .limit(TIMING_BATCH)
    .all();
  for (const row of pending) {
    const app = byId.get(row.appId);
    if (!app || row.runId === null) continue;
    const ms = await deps.github.getRunBillableMs(app.repoName, row.runId);
    await deps.db.update(deployments).set({ buildBillableMs: ms }).where(sql`${deployments.id} = ${row.id}`);
  }
}

/**
 * Hourly usage collection for today and yesterday (spec 13, USG-1.2/1.3/1.5–1.7). Every quantity here is a day
 * total that replaces the stored value, so re-running is idempotent; `emails` (an `add` metric) is never touched.
 * Metrics of a failed source are left as they were.
 */
export async function collectUsage(deps: UsageDeps): Promise<{ rows: number; apps: number; failed: Source[] }> {
  const started = deps.clock.now();
  const now = started;
  const today = utcDay(now);
  const days = [utcDay(now - DAY_MS), today];
  const failed: Source[] = [];
  const attempt = async (source: Source, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failed.push(source);
      deps.logger.error('usage source failed', { source, error });
      deps.metrics.write('usage_collection_failed', { sub: source, outcome: 'error' });
    }
  };

  const all: AppRef[] = await deps.db
    .select({
      id: apps.id,
      orgId: apps.orgId,
      slug: apps.slug,
      scriptName: apps.scriptName,
      d1DatabaseId: apps.d1DatabaseId,
      repoName: apps.repoName,
    })
    .from(apps)
    .all();
  const byId = new Map(all.map((a) => [a.id, a]));
  const byScript = new Map(all.map((a) => [a.scriptName, a]));
  const byDatabase = new Map(all.filter((a) => a.d1DatabaseId).map((a) => [a.d1DatabaseId as string, a]));
  const byHost = new Map(all.map((a) => [`${a.slug}.${deps.appsDomain}`.toLowerCase(), a]));

  const totals = new Totals();
  const collected = new Set<UsageMetric>();
  const done = (...metrics: UsageMetric[]) => {
    for (const m of metrics) collected.add(m);
  };

  await attempt('github', () => backfillBuildTimes(deps, byId, now));

  for (const day of days) {
    await attempt('workers', async () => {
      for (const row of await deps.analytics.workers(deps.dispatchNamespace, day)) {
        const app = byScript.get(row.scriptName);
        if (!app) continue;
        totals.add(app.id, day, 'requests', row.requests);
        totals.add(app.id, day, 'cpu_ms', row.cpuMs);
        totals.add(app.id, day, 'subrequests', row.subrequests);
      }
    });
    await attempt('assets', async () => {
      for (const row of await deps.analytics.assets(day)) {
        const app = byHost.get(row.hostname.toLowerCase());
        if (app) totals.add(app.id, day, 'asset_requests', row.requests);
      }
    });
    await attempt('d1', async () => {
      for (const row of await deps.analytics.d1(day)) {
        const app = byDatabase.get(row.databaseId);
        if (!app) continue;
        totals.add(app.id, day, 'd1_rows_read', row.rowsRead);
        totals.add(app.id, day, 'd1_rows_written', row.rowsWritten);
      }
    });
    await attempt('d1_storage', async () => {
      for (const row of await deps.analytics.d1Storage(day)) {
        const app = byDatabase.get(row.databaseId);
        if (app) totals.add(app.id, day, 'd1_storage_bytes', row.bytes);
      }
    });
  }
  if (!failed.includes('workers')) done('requests', 'cpu_ms', 'subrequests');
  if (!failed.includes('assets')) done('asset_requests');
  if (!failed.includes('d1')) done('d1_rows_read', 'd1_rows_written');
  if (!failed.includes('d1_storage')) done('d1_storage_bytes');

  // Log buffers are only asked about apps that served requests (all apps if Workers analytics failed).
  await attempt('logs', async () => {
    const candidates = all.filter(
      (a) => failed.includes('workers') || days.some((day) => totals.has(a.id, day, 'requests')),
    );
    for (const app of candidates) {
      const usage = await deps.appLogs(app.id).usage(days);
      for (const [day, { entries, bytes }] of Object.entries(usage)) {
        totals.add(app.id, day, 'log_entries', entries);
        totals.add(app.id, day, 'log_bytes', bytes);
      }
    }
    done('log_entries', 'log_bytes');
  });

  await attempt('builds', async () => {
    const since = Date.parse(`${days[0]}T00:00:00Z`);
    const rows = await deps.db
      .select()
      .from(deployments)
      .where(sql`${deployments.startedAt} >= ${since} OR ${deployments.finishedAt} >= ${since}`)
      .all();
    for (const row of rows) {
      if (row.startedAt !== null && row.startedAt >= since) totals.add(row.appId, utcDay(row.startedAt), 'builds', 1);
      if (row.finishedAt !== null && row.finishedAt >= since) {
        totals.add(row.appId, utcDay(row.finishedAt), 'build_ms', row.buildBillableMs ?? 0);
        if (row.status === 'succeeded') totals.add(row.appId, utcDay(row.finishedAt), 'deploys', 1);
      }
    }
    // Snapshot of retained artifacts, only for today (a past day keeps its last snapshot).
    const stored = await deps.db
      .select({ appId: deployments.appId, bytes: sql<number>`sum(${deployments.artifactBytes})` })
      .from(deployments)
      .where(isNotNull(deployments.artifactKey))
      .groupBy(deployments.appId)
      .all();
    for (const row of stored) totals.add(row.appId, today, 'artifact_bytes', row.bytes ?? 0);
    done('builds', 'build_ms', 'deploys', 'artifact_bytes');
  });

  const records: (typeof appUsageDaily.$inferInsert)[] = [];
  for (const [key, metrics] of totals.values) {
    const [appId, day] = key.split('|') as [string, string];
    const app = byId.get(appId);
    if (!app) continue;
    for (const [metric, quantity] of metrics) {
      if (!collected.has(metric) || USAGE_METRICS[metric].write !== 'replace') continue;
      records.push({ appId, orgId: app.orgId, day, metric, quantity, updatedAt: now });
    }
  }
  for (let i = 0; i < records.length; i += ROWS_PER_STATEMENT) {
    await deps.db
      .insert(appUsageDaily)
      .values(records.slice(i, i + ROWS_PER_STATEMENT))
      .onConflictDoUpdate({
        target: [appUsageDaily.appId, appUsageDaily.day, appUsageDaily.metric],
        set: { quantity: sql`excluded.quantity`, updatedAt: sql`excluded.updated_at` },
      });
  }

  const touchedApps = new Set(records.map((r) => r.appId)).size;
  deps.metrics.write('usage_collected', {
    outcome: failed.length ? 'error' : 'ok',
    durationMs: deps.clock.now() - started,
    bytes: records.length,
  });
  return { rows: records.length, apps: touchedApps, failed };
}
