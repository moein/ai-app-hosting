import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';
import type { AppRow } from './resolve';

export type DeploymentRow = typeof deployments.$inferSelect;

export const PublicDeploymentStatus = z.enum([
  'queued',
  'building',
  'deploying',
  'live',
  'superseded',
  'failed',
  'cancelled',
]);

/** `succeeded` is shown as `live` for the app's current deployment, otherwise `superseded` (DEP-3.1). */
export const publicStatus = (row: DeploymentRow, liveDeploymentId: string | null) =>
  row.status === 'succeeded' ? (row.id === liveDeploymentId ? 'live' : 'superseded') : row.status;

export const DeploymentSummarySchema = z
  .object({
    id: z.string(),
    status: PublicDeploymentStatus,
    trigger: z.enum(['push', 'redeploy', 'rollback']),
    commit_sha: z.string(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .nullable();

export async function latestDeployment(db: Db, app: AppRow): Promise<z.infer<typeof DeploymentSummarySchema>> {
  const row = await db
    .select()
    .from(deployments)
    .where(eq(deployments.appId, app.id))
    .orderBy(desc(deployments.createdAt))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    status: publicStatus(row, app.liveDeploymentId),
    trigger: row.trigger,
    commit_sha: row.commitSha,
    created_at: new Date(row.createdAt).toISOString(),
    finished_at: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}
