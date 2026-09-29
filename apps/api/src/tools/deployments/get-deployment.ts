import { GET_DEPLOYMENT_MAX_WAIT_S, PlatformError } from '@repo/shared';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { DeploymentViewSchema, isTerminal, toDeploymentView } from '../../builds/view';
import { apps, deployments } from '../../db/schema';
import { defineTool, type ToolContext } from '../../mcp/tool';

const POLL_MS = 2_000;

export const viewDeps = (ctx: ToolContext) => ({
  db: ctx.db,
  github: ctx.github,
  logger: ctx.logger,
  appsDomain: ctx.env.APPS_DOMAIN,
});

export const getDeployment = defineTool({
  name: 'get_deployment',
  title: 'Show a deployment',
  description:
    "Status of a deployment (default: the latest) — queued, building, deploying, live, superseded, failed or cancelled — with the build's errors when it failed. Pass wait_seconds (≤ 25) to wait for the status to change.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    deployment: z.string().optional().describe('Deployment id (dep_…); default: the latest.'),
    wait_seconds: z.number().int().min(0).max(GET_DEPLOYMENT_MAX_WAIT_S).default(0),
  }),
  output: DeploymentViewSchema,
  handler: async (input, ctx) => {
    let app = await resolveApp(ctx, input.app, { allowDeleted: true });
    const load = () =>
      ctx.db
        .select()
        .from(deployments)
        .where(
          input.deployment
            ? and(eq(deployments.appId, app.id), eq(deployments.id, input.deployment))
            : eq(deployments.appId, app.id),
        )
        .orderBy(desc(deployments.createdAt))
        .get();
    let row = await load();
    if (!row)
      throw new PlatformError('NOT_FOUND', {
        message: 'No deployment yet.',
        hint: 'Deployments start with write_files.',
      });

    // DEP-3.2: wait until the status changes or becomes terminal.
    const initial = row.status;
    const deadline = ctx.clock.now() + input.wait_seconds * 1000;
    while (
      !isTerminal(row.status === 'succeeded' ? 'live' : row.status) &&
      row.status === initial &&
      ctx.clock.now() < deadline
    ) {
      await ctx.sleep(POLL_MS);
      row = (await load()) ?? row;
    }
    app = (await ctx.db.select().from(apps).where(eq(apps.id, app.id)).get()) ?? app;
    return toDeploymentView(viewDeps(ctx), app, row);
  },
});
