import { DEPLOY_BUILDING_TIMEOUT_MS, DEPLOY_QUEUED_TIMEOUT_MS } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { insertApp } from '../../src/apps/insert';
import { deployments } from '../../src/db/schema';
import { pruneArtifacts, sweepStaleDeployments } from '../../src/jobs/build-sweeps';
import { signIn, testContext } from '../mcp/helpers';

describe('build sweeps (DEP-2.12, artifact retention)', () => {
  it('fails deployments stuck in queued or building', async () => {
    const ctx = testContext();
    await signIn(ctx);
    const app = await insertApp(ctx, { name: 'Sweep' });
    const now = ctx.clock.now();
    const row = (id: string, status: 'queued' | 'building', createdAt: number, startedAt: number | null = null) => ({
      id,
      appId: app.id,
      orgId: app.orgId,
      trigger: 'push' as const,
      commitSha: 'a',
      status,
      createdAt,
      startedAt,
    });
    await ctx.db
      .insert(deployments)
      .values([
        row('dep_q_old', 'queued', now - DEPLOY_QUEUED_TIMEOUT_MS - 1),
        row('dep_q_new', 'queued', now - 1_000),
        row('dep_b_old', 'building', now, now - DEPLOY_BUILDING_TIMEOUT_MS - 1),
      ]);
    expect(await sweepStaleDeployments(ctx.db, now)).toBe(2);
    const status = async (id: string) => ctx.db.select().from(deployments).where(eq(deployments.id, id)).get();
    expect(await status('dep_q_old')).toMatchObject({ status: 'failed', errorCode: 'BUILD_FAILED' });
    expect(JSON.parse((await status('dep_q_old'))?.errorDetails ?? '{}').message).toContain('did not start');
    expect(JSON.parse((await status('dep_b_old'))?.errorDetails ?? '{}').message).toContain('timed out');
    expect((await status('dep_q_new'))?.status).toBe('queued');
  });

  it('keeps the 20 newest successful artifacts plus the live one', async () => {
    const ctx = testContext();
    await signIn(ctx);
    const app = await insertApp(ctx, { name: 'Prune' });
    const rows = Array.from({ length: 23 }, (_, i) => ({
      id: `dep_prune_${String(i).padStart(2, '0')}`,
      appId: app.id,
      orgId: app.orgId,
      trigger: 'push' as const,
      commitSha: 'a',
      status: 'succeeded' as const,
      artifactKey: `artifacts/${app.id}/${i}.tar.gz`,
      createdAt: i,
    }));
    // D1 allows ≤ 100 bound variables per statement, so insert in chunks.
    for (let i = 0; i < rows.length; i += 10) await ctx.db.insert(deployments).values(rows.slice(i, i + 10));
    for (const r of rows) await ctx.artifacts.put(r.artifactKey, 'x');
    const { apps } = await import('../../src/db/schema');
    await ctx.db.update(apps).set({ liveDeploymentId: 'dep_prune_00' }).where(eq(apps.id, app.id));
    expect(await pruneArtifacts(ctx.db, ctx.artifacts)).toBe(2);
    expect(await ctx.artifacts.get(`artifacts/${app.id}/0.tar.gz`)).not.toBeNull();
    expect(await ctx.artifacts.get(`artifacts/${app.id}/1.tar.gz`)).toBeNull();
    expect(await ctx.artifacts.get(`artifacts/${app.id}/22.tar.gz`)).not.toBeNull();
  });
});
