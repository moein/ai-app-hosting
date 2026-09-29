import { and, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { DeploymentViewSchema, toDeploymentView } from '../../builds/view';
import { deployments } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { viewDeps } from './get-deployment';

export const listDeployments = defineTool({
  name: 'list_deployments',
  title: 'List deployments',
  description: "The app's deployments, newest first. Pass next_cursor as `before` to page back.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    limit: z.number().int().min(1).max(50).default(10),
    before: z.string().optional().describe('Cursor from a previous next_cursor.'),
  }),
  output: z.object({ deployments: z.array(DeploymentViewSchema), next_cursor: z.string().nullable() }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { allowDeleted: true });
    const cursor = input.before
      ? await ctx.db
          .select()
          .from(deployments)
          .where(and(eq(deployments.appId, app.id), eq(deployments.id, input.before)))
          .get()
      : undefined;
    const rows = await ctx.db
      .select()
      .from(deployments)
      .where(
        cursor
          ? and(
              eq(deployments.appId, app.id),
              or(
                lt(deployments.createdAt, cursor.createdAt),
                and(eq(deployments.createdAt, cursor.createdAt), lt(deployments.id, cursor.id)),
              ),
            )
          : eq(deployments.appId, app.id),
      )
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(input.limit + 1)
      .all();
    const page = rows.slice(0, input.limit);
    return {
      deployments: await Promise.all(page.map((row) => toDeploymentView(viewDeps(ctx), app, row))),
      next_cursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});
