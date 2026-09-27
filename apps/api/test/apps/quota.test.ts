import { MAX_APPS_PER_ORG, MAX_DEPLOYS_PER_ORG_PER_DAY, type PlatformError } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { checkAppQuota, consumeDaily, dailyUsage, refundDaily } from '../../src/apps/quota';
import { signIn, testContext } from '../mcp/helpers';

describe('quotas (APP-5)', () => {
  it('stops exactly at the daily max even under concurrency (APP-5.2)', async () => {
    const ctx = testContext();
    const { orgId } = await signIn(ctx);
    const now = ctx.clock.now();
    const results = await Promise.allSettled(
      Array.from({ length: MAX_DEPLOYS_PER_ORG_PER_DAY + 5 }, () => consumeDaily(ctx.db, orgId, 'deploys', now)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_DEPLOYS_PER_ORG_PER_DAY);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as PlatformError).details).toMatchObject({
      limit: 'deploys',
      max: MAX_DEPLOYS_PER_ORG_PER_DAY,
      resets_at: '2026-09-27T00:00:00.000Z',
    });
  });

  it('resets at UTC midnight and supports refunds and multi-unit consumption', async () => {
    const ctx = testContext();
    const { orgId } = await signIn(ctx);
    const now = ctx.clock.now();
    await consumeDaily(ctx.db, orgId, 'emails', now, 10);
    await refundDaily(ctx.db, orgId, 'emails', now, 3);
    expect((await dailyUsage(ctx.db, orgId, 'emails', now)).used).toBe(7);
    expect((await dailyUsage(ctx.db, orgId, 'emails', now + 86_400_000)).used).toBe(0);
    await expect(consumeDaily(ctx.db, orgId, 'emails', now, 10_000)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('limits active apps per org (APP-2.8)', async () => {
    const ctx = testContext();
    const { orgId } = await signIn(ctx);
    await expect(checkAppQuota(ctx.db, orgId)).resolves.toBeUndefined();
    expect(MAX_APPS_PER_ORG).toBe(10);
  });
});
