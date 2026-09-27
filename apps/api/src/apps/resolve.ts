import { PlatformError } from '@repo/shared';
import { and, eq } from 'drizzle-orm';
import { apps } from '../db/schema';
import type { ToolContext } from '../mcp/tool';

export type AppRow = typeof apps.$inferSelect;

/**
 * Looks up an app by slug within the acting org only (APP-3.3); other orgs' apps are indistinguishable from
 * missing ones. Deleted apps → APP_DELETED unless allowed (APP-3.4); unprovisioned → APP_NOT_READY (APP-3.5).
 */
export async function resolveApp(
  ctx: ToolContext,
  slug: string,
  options: { allowDeleted?: boolean; requireReady?: boolean } = {},
): Promise<AppRow> {
  if (!ctx.orgId) throw new PlatformError('AUTH_REQUIRED');
  const app = await ctx.db
    .select()
    .from(apps)
    .where(and(eq(apps.orgId, ctx.orgId), eq(apps.slug, slug)))
    .get();
  if (!app) {
    throw new PlatformError('NOT_FOUND', { message: `No app "${slug}".`, hint: 'Call list_apps to see your apps.' });
  }
  ctx.app = { id: app.id, slug: app.slug };
  if (app.status === 'deleted' && !options.allowDeleted) throw new PlatformError('APP_DELETED');
  if (options.requireReady && app.provisioning !== 'ready') {
    throw new PlatformError('APP_NOT_READY', { details: { provisioning: app.provisioning } });
  }
  return app;
}
