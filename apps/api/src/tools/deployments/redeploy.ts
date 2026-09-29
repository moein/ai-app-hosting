import { newId, PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { consumeDaily, refundDaily } from '../../apps/quota';
import { resolveApp } from '../../apps/resolve';
import { recordDeploymentFinished } from '../../builds/metrics';
import { transition } from '../../builds/state';
import { DeploymentViewSchema, toDeploymentView } from '../../builds/view';
import { deployments } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { viewDeps } from './get-deployment';

export const redeploy = defineTool({
  name: 'redeploy',
  title: 'Redeploy the app',
  description: "Rebuilds and deploys the app's current code (latest commit on main) without changing any file.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({ app: z.string().describe('The app slug.') }),
  output: DeploymentViewSchema,
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const now = ctx.clock.now();
    await consumeDaily(ctx.db, app.orgId, 'deploys', now);
    const head = await ctx.github.getHead(app.repoName);
    if (!head) {
      await refundDaily(ctx.db, app.orgId, 'deploys', now);
      throw new PlatformError('APP_NOT_READY', { message: 'The repository has no commits yet.' });
    }
    const id = newId('dep');
    const row = await ctx.db
      .insert(deployments)
      .values({
        id,
        appId: app.id,
        orgId: app.orgId,
        trigger: 'redeploy',
        commitSha: head.commitSha,
        status: 'queued',
        createdBy: ctx.userId ?? null,
        createdAt: now,
      })
      .returning()
      .get();
    try {
      await ctx.github.dispatchWorkflow(app.repoName, 'deploy.yml', { deployment_id: id }); // DEP-4.1
    } catch (error) {
      if (await transition(ctx.db, id, ['queued'], { status: 'failed', errorCode: 'DEPLOY_FAILED', finishedAt: now })) {
        await recordDeploymentFinished(ctx.db, ctx.metrics, [id]);
      }
      await refundDaily(ctx.db, app.orgId, 'deploys', now);
      throw error;
    }
    return toDeploymentView(
      viewDeps(ctx),
      app,
      (await ctx.db.select().from(deployments).where(eq(deployments.id, id)).get()) ?? row,
    );
  },
});
