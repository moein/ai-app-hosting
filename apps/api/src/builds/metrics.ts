import type { Metrics } from '@repo/shared';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';

const span = (from: number | null, to: number | null) => (from !== null && to !== null ? Math.max(0, to - from) : null);

/**
 * EVT-2.4: one `deployment_finished` data point per deployment that just reached a terminal state
 * (succeeded, failed or cancelled): total, build and deploy durations and the artifact size.
 */
export async function recordDeploymentFinished(db: Db, metrics: Metrics, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.select().from(deployments).where(inArray(deployments.id, ids)).all();
  for (const row of rows) {
    metrics.write('deployment_finished', {
      orgId: row.orgId,
      appId: row.appId,
      userId: row.createdBy,
      sub: row.status,
      outcome: row.status === 'succeeded' ? 'ok' : 'error',
      errorCode: row.errorCode,
      durationMs: span(row.createdAt, row.finishedAt),
      bytes: row.artifactBytes,
      phase1Ms: span(row.startedAt, row.buildFinishedAt),
      phase2Ms: span(row.buildFinishedAt, row.finishedAt),
    });
  }
}
