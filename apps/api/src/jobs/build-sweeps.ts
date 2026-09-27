import { ARTIFACTS_RETAINED_PER_APP, DEPLOY_BUILDING_TIMEOUT_MS, DEPLOY_QUEUED_TIMEOUT_MS } from '@repo/shared';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import type { ArtifactStore } from '../builds/deploy';
import type { Db } from '../db/client';
import { apps, deployments } from '../db/schema';

/** DEP-2.12: builds that never started or never finished are failed with an explanation. */
export async function sweepStaleDeployments(db: Db, now: number): Promise<number> {
  const stale = [
    ...(await db
      .select()
      .from(deployments)
      .where(and(eq(deployments.status, 'queued'), lt(deployments.createdAt, now - DEPLOY_QUEUED_TIMEOUT_MS)))
      .all()),
    ...(await db
      .select()
      .from(deployments)
      .where(and(eq(deployments.status, 'building'), lt(deployments.startedAt, now - DEPLOY_BUILDING_TIMEOUT_MS)))
      .all()),
  ];
  for (const row of stale) {
    const message = row.status === 'queued' ? 'The build did not start.' : 'The build timed out.';
    await db
      .update(deployments)
      .set({ status: 'failed', errorCode: 'BUILD_FAILED', errorDetails: JSON.stringify({ message }), finishedAt: now })
      .where(and(eq(deployments.id, row.id), eq(deployments.status, row.status)));
  }
  return stale.length;
}

/** Keeps the artifacts of the 20 newest successful deployments per app, plus the live one (spec 08). */
export async function pruneArtifacts(db: Db, artifacts: ArtifactStore): Promise<number> {
  let removed = 0;
  for (const app of await db.select().from(apps).all()) {
    const withArtifacts = await db
      .select()
      .from(deployments)
      .where(
        and(eq(deployments.appId, app.id), eq(deployments.status, 'succeeded'), isNotNull(deployments.artifactKey)),
      )
      .orderBy(desc(deployments.createdAt))
      .all();
    const keep = new Set(withArtifacts.slice(0, ARTIFACTS_RETAINED_PER_APP).map((row) => row.artifactKey));
    const live = withArtifacts.find((row) => row.id === app.liveDeploymentId);
    if (live) keep.add(live.artifactKey);
    for (const row of withArtifacts) {
      if (keep.has(row.artifactKey)) continue;
      // Rollback copies reuse the source key; only delete keys no kept deployment still points to.
      await artifacts.delete(row.artifactKey as string);
      await db.update(deployments).set({ artifactKey: null }).where(eq(deployments.id, row.id));
      removed++;
    }
  }
  return removed;
}
