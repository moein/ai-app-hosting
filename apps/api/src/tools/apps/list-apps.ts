import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppSummarySchema, toAppSummary } from '../../apps/summary';
import { apps } from '../../db/schema';
import { defineTool } from '../../mcp/tool';

export const listApps = defineTool({
  name: 'list_apps',
  title: 'List my apps',
  description: "Lists the user's apps (newest first) with their address, setup state and live deployment.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({ apps: z.array(AppSummarySchema) }),
  handler: async (_input, ctx) => {
    const rows = await ctx.db
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, ctx.orgId as string), eq(apps.status, 'active')))
      .orderBy(desc(apps.createdAt))
      .all();
    return { apps: await Promise.all(rows.map((row) => toAppSummary(ctx.db, row, ctx.env.APPS_DOMAIN))) };
  },
});
