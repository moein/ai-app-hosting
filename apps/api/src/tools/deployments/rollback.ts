import { newId, PlatformError } from '@repo/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { publicStatus } from '../../apps/deployments';
import { consumeDaily } from '../../apps/quota';
import { resolveApp } from '../../apps/resolve';
import { DeploymentViewSchema, toDeploymentView } from '../../builds/view';
import { deployments } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { viewDeps } from './get-deployment';

const WARNING =
  'Database migrations are not reverted. The code on main is unchanged, so the next write_files with deploy=true ships the current code again.';

export const rollback = defineTool({
  name: 'rollback',
  title: 'Roll back to a deployment',
  description:
    'Restores a previously live version of the app (a "superseded" deployment from list_deployments) without rebuilding. Database migrations are not reverted.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    deployment: z.string().describe('The superseded deployment to restore.'),
  }),
  output: DeploymentViewSchema.extend({ warning: z.string() }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const source = await ctx.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.appId, app.id), eq(deployments.id, input.deployment)))
      .get();
    if (!source) throw new PlatformError('NOT_FOUND', { message: `No deployment ${input.deployment}.` });
    const artifactExists = source.artifactKey ? (await ctx.artifacts.get(source.artifactKey)) !== null : false;
    if (publicStatus(source, app.liveDeploymentId) !== 'superseded' || !artifactExists) {
      throw new PlatformError('DEPLOYMENT_NOT_ROLLBACKABLE'); // DEP-4.3
    }
    const now = ctx.clock.now();
    await consumeDaily(ctx.db, app.orgId, 'deploys', now);
    const row = await ctx.db
      .insert(deployments)
      .values({
        id: newId('dep'),
        appId: app.id,
        orgId: app.orgId,
        trigger: 'rollback',
        commitSha: source.commitSha,
        commitMessage: source.commitMessage,
        sourceDeploymentId: source.id,
        status: 'deploying',
        artifactKey: source.artifactKey,
        artifactBytes: source.artifactBytes,
        createdBy: ctx.userId ?? null,
        createdAt: now,
        startedAt: now,
      })
      .returning()
      .get();
    await ctx.deployer.start({ deploymentId: row.id, artifactKey: source.artifactKey as string, skipMigrations: true });
    return { ...(await toDeploymentView(viewDeps(ctx), app, row)), warning: WARNING }; // DEP-4.4
  },
});
