import { PlatformError } from '@repo/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { recordDeploymentFinished } from '../../builds/metrics';
import { appSecrets, apps, deployments } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { deleteRoute } from '../../runtime/routes';

export const deleteApp = defineTool({
  name: 'delete_app',
  title: 'Delete an app',
  description:
    "Takes an app offline by deleting its running Worker (and its secrets). The code and the database are kept. Always confirm with the user first, and pass the app's slug again as confirm_slug.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    confirm_slug: z.string().describe('The same slug again, to confirm.'),
  }),
  output: z.object({
    slug: z.string(),
    status: z.literal('deleted'),
    kept: z.array(z.string()),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app);
    if (input.confirm_slug !== app.slug) {
      throw new PlatformError('INVALID_INPUT', {
        message: 'confirm_slug does not match the app.',
        details: { issues: [{ path: ['confirm_slug'], message: `Must be "${app.slug}".` }] },
      });
    }
    const now = ctx.clock.now();
    // In-flight builds are cancelled; their artifacts will be refused (APP-4.7).
    const cancelled = await ctx.db
      .update(deployments)
      .set({ status: 'cancelled', finishedAt: now })
      .where(and(eq(deployments.appId, app.id), inArray(deployments.status, ['queued', 'building', 'deploying'])))
      .returning({ id: deployments.id })
      .all();
    await recordDeploymentFinished(
      ctx.db,
      ctx.metrics,
      cancelled.map((row) => row.id),
    );
    // Only the Worker goes (APP-4.1, APP-4.2); a missing script is fine (APP-4.6).
    await ctx.cloudflare.deleteScript(app.scriptName);
    await deleteRoute(ctx.routes, app.slug);
    await ctx.db.batch([
      ctx.db.delete(appSecrets).where(eq(appSecrets.appId, app.id)),
      ctx.db.update(apps).set({ status: 'deleted', deletedAt: now, updatedAt: now }).where(eq(apps.id, app.id)),
    ]);
    return { slug: app.slug, status: 'deleted' as const, kept: ['source code', 'database', 'deployment history'] };
  },
});
