import { MAX_APPS_PER_ORG, MAX_DEPLOYS_PER_ORG_PER_DAY, MAX_EMAILS_PER_ORG_PER_DAY, PlatformError } from '@repo/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apps, usageCounters } from '../db/schema';

export type DailyMetric = 'deploys' | 'emails';

export const DAILY_LIMITS: Record<DailyMetric, number> = {
  deploys: MAX_DEPLOYS_PER_ORG_PER_DAY,
  emails: MAX_EMAILS_PER_ORG_PER_DAY,
};

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextMidnight = (now: number) => {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
};

export async function activeAppCount(db: Db, orgId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(apps)
    .where(and(eq(apps.orgId, orgId), eq(apps.status, 'active')))
    .get();
  return row?.n ?? 0;
}

/** APP-2.8: only active apps count (deleted ones keep their resources but not the quota). */
export async function checkAppQuota(db: Db, orgId: string): Promise<void> {
  if ((await activeAppCount(db, orgId)) >= MAX_APPS_PER_ORG) {
    throw new PlatformError('QUOTA_EXCEEDED', { details: { limit: 'apps', max: MAX_APPS_PER_ORG } });
  }
}

/**
 * Atomic check-and-add of `amount` to today's counter (APP-5.2). The conditional upsert only applies when the
 * result stays within the limit; no returned row means the quota would be exceeded.
 */
export async function consumeDaily(db: Db, orgId: string, metric: DailyMetric, now: number, amount = 1): Promise<void> {
  const max = DAILY_LIMITS[metric];
  const exceeded = () =>
    new PlatformError('QUOTA_EXCEEDED', { details: { limit: metric, max, resets_at: nextMidnight(now) } });
  if (amount > max) throw exceeded();
  const row = await db
    .insert(usageCounters)
    .values({ orgId, metric, day: dayOf(now), count: amount })
    .onConflictDoUpdate({
      target: [usageCounters.orgId, usageCounters.metric, usageCounters.day],
      set: { count: sql`${usageCounters.count} + ${amount}` },
      setWhere: sql`${usageCounters.count} + ${amount} <= ${max}`,
    })
    .returning({ count: usageCounters.count })
    .get();
  if (!row) throw exceeded();
}

/** Gives back units consumed for work that didn't happen (e.g. a no-op commit). */
export async function refundDaily(db: Db, orgId: string, metric: DailyMetric, now: number, amount = 1): Promise<void> {
  await db
    .update(usageCounters)
    .set({ count: sql`max(${usageCounters.count} - ${amount}, 0)` })
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.metric, metric), eq(usageCounters.day, dayOf(now))));
}

export async function dailyUsage(db: Db, orgId: string, metric: DailyMetric, now: number) {
  const row = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.metric, metric), eq(usageCounters.day, dayOf(now))))
    .get();
  return { used: row?.count ?? 0, max: DAILY_LIMITS[metric], resets_at: nextMidnight(now) };
}
