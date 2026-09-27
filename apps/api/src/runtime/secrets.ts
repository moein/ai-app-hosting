import { eq } from 'drizzle-orm';
import type { AppRow } from '../apps/resolve';
import { gunzip, inspectArtifact, untar } from '../builds/artifact';
import { deployments } from '../db/schema';
import type { ToolContext } from '../mcp/tool';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RESERVED_NAMES = new Set(['DB', 'ASSETS', 'EMAIL']);

/** Names of the app's plain `vars` in its live deployment (a secret can't reuse one, RUN-3.2). */
export async function liveVarNames(ctx: ToolContext, app: AppRow): Promise<string[]> {
  if (!app.liveDeploymentId) return [];
  const live = await ctx.db.select().from(deployments).where(eq(deployments.id, app.liveDeploymentId)).get();
  if (!live?.artifactKey) return [];
  const object = await ctx.artifacts.get(live.artifactKey);
  if (!object) return [];
  try {
    return Object.keys(inspectArtifact(untar(await gunzip(await object.arrayBuffer()))).config.vars);
  } catch {
    return [];
  }
}
