import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';

export type DeploymentStatus = (typeof deployments.$inferSelect)['status'];

/**
 * Conditional state transitions (spec 08 design): the UPDATE only applies from an allowed status, so racing
 * callbacks, sweeps and deletions can't move a deployment backwards. Returns whether the row changed.
 */
export async function transition(
  db: Db,
  id: string,
  from: DeploymentStatus[],
  values: Partial<typeof deployments.$inferInsert> & { status: DeploymentStatus },
): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set(values)
    .where(and(eq(deployments.id, id), inArray(deployments.status, from)))
    .returning({ id: deployments.id })
    .all();
  return updated.length > 0;
}

/** A newer build started: older queued/building ones for the app are cancelled (DEP-2.2). */
export async function cancelOthers(db: Db, appId: string, keepId: string, now: number): Promise<string[]> {
  const cancelled = await db
    .update(deployments)
    .set({ status: 'cancelled', finishedAt: now })
    .where(
      and(
        eq(deployments.appId, appId),
        ne(deployments.id, keepId),
        inArray(deployments.status, ['queued', 'building']),
      ),
    )
    .returning({ id: deployments.id })
    .all();
  return cancelled.map((row) => row.id);
}
