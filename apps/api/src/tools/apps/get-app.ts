import { z } from 'zod';
import { DeploymentSummarySchema, latestDeployment } from '../../apps/deployments';
import { resolveApp } from '../../apps/resolve';
import { AppSummarySchema, toAppSummary } from '../../apps/summary';
import { defineTool } from '../../mcp/tool';

export const getApp = defineTool({
  name: 'get_app',
  title: 'Show an app',
  description: "Details of one app: address, setup state, live and latest deployment, and the code's latest commit.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ app: z.string().describe('The app slug.') }),
  output: AppSummarySchema.extend({
    provisioning_error: z.string().optional(),
    latest_deployment: DeploymentSummarySchema,
    repo: z.object({ default_branch: z.literal('main'), head_commit_sha: z.string().nullable() }),
    next_step: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { allowDeleted: true });
    let head: string | null = null;
    if (app.provisioning === 'ready' && app.status === 'active') {
      try {
        head = (await ctx.github.getHead(app.repoName))?.commitSha ?? null;
      } catch (error) {
        ctx.logger.warn('could not read repo head', { app: app.slug, error });
      }
    }
    return {
      ...(await toAppSummary(ctx.db, app, ctx.env.APPS_DOMAIN)),
      ...(app.provisioningError ? { provisioning_error: app.provisioningError } : {}),
      latest_deployment: await latestDeployment(ctx.db, app),
      repo: { default_branch: 'main' as const, head_commit_sha: head },
      ...(app.provisioning === 'failed' ? { next_step: 'Setup failed. Call retry_provisioning.' } : {}),
    };
  },
});
