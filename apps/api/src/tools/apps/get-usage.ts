import { MAX_APPS_PER_ORG } from '@repo/shared';
import { z } from 'zod';
import { activeAppCount, dailyUsage } from '../../apps/quota';
import { defineTool } from '../../mcp/tool';

const Daily = z.object({ used: z.number(), max: z.number(), resets_at: z.string() });

export const getUsage = defineTool({
  name: 'get_usage',
  title: 'Show usage and quotas',
  description: 'Current usage against the account limits: apps, deployments today and emails today.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    apps: z.object({ used: z.number(), max: z.number() }),
    deploys_today: Daily,
    emails_today: Daily,
  }),
  handler: async (_input, ctx) => {
    const orgId = ctx.orgId as string;
    const now = ctx.clock.now();
    return {
      apps: { used: await activeAppCount(ctx.db, orgId), max: MAX_APPS_PER_ORG },
      deploys_today: await dailyUsage(ctx.db, orgId, 'deploys', now),
      emails_today: await dailyUsage(ctx.db, orgId, 'emails', now),
    };
  },
});
