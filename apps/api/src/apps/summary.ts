import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';
import { appUrl } from './names';
import type { AppRow } from './resolve';

export const LiveDeploymentSchema = z
  .object({ id: z.string(), commit_sha: z.string(), deployed_at: z.string() })
  .nullable();

export const AppSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  status: z.enum(['active', 'deleted']),
  provisioning: z.enum(['pending', 'ready', 'failed']),
  live_deployment: LiveDeploymentSchema,
  created_at: z.string(),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

const iso = (ms: number) => new Date(ms).toISOString();

export async function liveDeployment(db: Db, app: AppRow): Promise<AppSummary['live_deployment']> {
  if (!app.liveDeploymentId) return null;
  const row = await db.select().from(deployments).where(eq(deployments.id, app.liveDeploymentId)).get();
  return row ? { id: row.id, commit_sha: row.commitSha, deployed_at: iso(row.finishedAt ?? row.createdAt) } : null;
}

export async function toAppSummary(db: Db, app: AppRow, appsDomain: string): Promise<AppSummary> {
  return {
    slug: app.slug,
    name: app.name,
    url: appUrl(app.slug, appsDomain),
    status: app.status,
    provisioning: app.provisioning,
    live_deployment: await liveDeployment(db, app),
    created_at: iso(app.createdAt),
  };
}
