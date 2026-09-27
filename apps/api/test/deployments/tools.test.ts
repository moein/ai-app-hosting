import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyUsage } from '../../src/apps/quota';
import { apps, deployments } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { getDeployment } from '../../src/tools/deployments/get-deployment';
import { listDeployments } from '../../src/tools/deployments/list-deployments';
import { redeploy } from '../../src/tools/deployments/redeploy';
import { rollback } from '../../src/tools/deployments/rollback';
import { writeFiles } from '../../src/tools/files/write-files';
import { artifactFiles, gzip, makeTar } from '../builds/tar';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

type View = {
  id: string;
  status: string;
  url: string | null;
  error: Record<string, unknown> | null;
  next_step: string;
  warning?: string;
};
const data = <T = View>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => (r.structuredContent as { error: { code: string } }).error;

async function appWithDeploy(): Promise<{ ctx: TestContext; slug: string; depId: string }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = data<{ slug: string }>(
    await runTool(createApp, { name: `Dep ${Math.random().toString(36).slice(2, 8)}` }, ctx),
  );
  const write = data<{ deployment: { id: string } }>(
    await runTool(writeFiles, { app: slug, message: 'v1', files: [{ path: 'a', content: '1' }] }, ctx),
  );
  return { ctx, slug, depId: write.deployment.id };
}

/** Simulates the build + DeployApp for a deployment: artifact in R2, then the inline deployer. */
async function succeed(ctx: TestContext, id: string) {
  const key = `artifacts/test/${id}.tar.gz`;
  await ctx.artifacts.put(key, await gzip(makeTar(artifactFiles())));
  await ctx.db.update(deployments).set({ status: 'deploying', artifactKey: key }).where(eq(deployments.id, id));
  await ctx.deployer.start({ deploymentId: id, artifactKey: key, skipMigrations: false });
}

describe('get_deployment (DEP-3.1, DEP-3.2, LOG-1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the latest deployment and its live URL', async () => {
    const { ctx, slug, depId } = await appWithDeploy();
    expect(data(await runTool(getDeployment, { app: slug }, ctx))).toMatchObject({
      id: depId,
      status: 'queued',
      url: null,
    });
    await succeed(ctx, depId);
    const live = data(await runTool(getDeployment, { app: slug, deployment: depId }, ctx));
    expect(live).toMatchObject({ status: 'live', url: `https://${slug}.motad.app` });
    expect(live.next_step).toContain('live at');
  });

  it('waits until the status changes, or until wait_seconds elapses', async () => {
    const { ctx, slug, depId } = await appWithDeploy();
    let polls = 0;
    ctx.sleep = async (ms) => {
      ctx.clock.advance(ms);
      if (++polls === 3) await ctx.db.update(deployments).set({ status: 'building' }).where(eq(deployments.id, depId));
    };
    expect(data(await runTool(getDeployment, { app: slug, wait_seconds: 25 }, ctx)).status).toBe('building');
    expect(polls).toBe(3);

    ctx.sleep = async (ms) => void ctx.clock.advance(ms);
    const start = ctx.clock.now();
    expect(data(await runTool(getDeployment, { app: slug, wait_seconds: 10 }, ctx)).status).toBe('building');
    expect(ctx.clock.now() - start).toBeGreaterThanOrEqual(10_000);
  });

  it('returns contract violations or the build log with parsed errors (LOG-1.1, LOG-1.4)', async () => {
    const { ctx, slug, depId } = await appWithDeploy();
    await ctx.db
      .update(deployments)
      .set({
        status: 'failed',
        errorCode: 'CONTRACT_VIOLATION',
        errorDetails: JSON.stringify({ step: 'validate', violations: [{ rule: 'CON-R01' }] }),
      })
      .where(eq(deployments.id, depId));
    expect(data(await runTool(getDeployment, { app: slug }, ctx)).error).toMatchObject({
      code: 'CONTRACT_VIOLATION',
      step: 'validate',
      violations: [{ rule: 'CON-R01' }],
    });

    await ctx.db
      .update(deployments)
      .set({
        errorCode: 'BUILD_FAILED',
        errorDetails: JSON.stringify({
          step: 'typecheck',
          log_tail: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
        }),
      })
      .where(eq(deployments.id, depId));
    const error = data(await runTool(getDeployment, { app: slug }, ctx)).error;
    expect(error).toMatchObject({
      code: 'BUILD_FAILED',
      step: 'typecheck',
      errors: [{ kind: 'typescript', file: 'src/a.ts', line: 1 }],
    });
  });

  it('fetches a missing build log from the GitHub job once and stores it (LOG-1.3)', async () => {
    const { ctx, slug, depId } = await appWithDeploy();
    ctx.fakes.github.runJobs.set(9, [{ id: 91, name: 'deploy', conclusion: 'failure' }]);
    ctx.fakes.github.jobLogs.set(
      91,
      "##[group]Run npm run build\nsrc/b.ts(2,3): error TS1005: ';' expected.\n##[error]Process completed with exit code 2.",
    );
    await ctx.db
      .update(deployments)
      .set({
        status: 'failed',
        errorCode: 'BUILD_FAILED',
        runId: 9,
        errorDetails: JSON.stringify({ message: 'The build timed out.' }),
      })
      .where(eq(deployments.id, depId));
    const error = data(await runTool(getDeployment, { app: slug }, ctx)).error;
    expect(error?.errors).toEqual([expect.objectContaining({ file: 'src/b.ts', code: 'TS1005' })]);
    const stored = JSON.parse(
      (await ctx.db.select().from(deployments).where(eq(deployments.id, depId)).get())?.errorDetails ?? '{}',
    );
    expect(stored.log_tail).toContain('TS1005');
  });
});

describe('list_deployments (DEP-3.3)', () => {
  it('pages newest first with a cursor', async () => {
    const { ctx, slug } = await appWithDeploy();
    for (let i = 2; i <= 4; i++) {
      ctx.clock.advance(1_000);
      data(await runTool(writeFiles, { app: slug, message: `v${i}`, files: [{ path: 'a', content: String(i) }] }, ctx));
    }
    const page1 = data<{ deployments: View[]; next_cursor: string }>(
      await runTool(listDeployments, { app: slug, limit: 3 }, ctx),
    );
    expect(page1.deployments).toHaveLength(3);
    const page2 = data<{ deployments: View[]; next_cursor: string | null }>(
      await runTool(listDeployments, { app: slug, limit: 3, before: page1.next_cursor }, ctx),
    );
    expect(page2.deployments).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    expect(new Set([...page1.deployments, ...page2.deployments].map((d) => d.id)).size).toBe(4);
  });
});

describe('redeploy / rollback (DEP-4)', () => {
  it('redeploy queues a deployment for the head of main, dispatches the workflow and counts the quota', async () => {
    const { ctx, slug } = await appWithDeploy();
    const before = (await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used;
    const view = data(await runTool(redeploy, { app: slug }, ctx));
    expect(view.status).toBe('queued');
    expect(ctx.fakes.github.repos.get(`dev-${slug}`)?.dispatches).toEqual([{ deployment_id: view.id }]);
    expect((await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used).toBe(before + 1);
  });

  it('rollback restores a superseded deployment without migrations, with a warning', async () => {
    const { ctx, slug, depId: first } = await appWithDeploy();
    await succeed(ctx, first);
    const second = data<{ deployment: { id: string } }>(
      await runTool(writeFiles, { app: slug, message: 'v2', files: [{ path: 'a', content: '2' }] }, ctx),
    ).deployment.id;
    await succeed(ctx, second);
    expect(errorOf(await runTool(rollback, { app: slug, deployment: second }, ctx)).code).toBe(
      'DEPLOYMENT_NOT_ROLLBACKABLE',
    );

    const migrationsBefore = ctx.fakes.cloudflare.callsTo('d1Query').length;
    const view = data(await runTool(rollback, { app: slug, deployment: first }, ctx));
    expect(view.warning).toContain('migrations are not reverted');
    expect(ctx.fakes.cloudflare.callsTo('d1Query')).toHaveLength(migrationsBefore);
    const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
    expect(app?.liveDeploymentId).toBe(view.id);
    expect(data(await runTool(getDeployment, { app: slug, deployment: view.id }, ctx))).toMatchObject({
      status: 'live',
    });
  });

  it('refuses rollback when the artifact is gone', async () => {
    const { ctx, slug, depId: first } = await appWithDeploy();
    await succeed(ctx, first);
    const second = data<{ deployment: { id: string } }>(
      await runTool(writeFiles, { app: slug, message: 'v2', files: [{ path: 'a', content: '2' }] }, ctx),
    ).deployment.id;
    await succeed(ctx, second);
    await ctx.artifacts.delete(`artifacts/test/${first}.tar.gz`);
    expect(errorOf(await runTool(rollback, { app: slug, deployment: first }, ctx)).code).toBe(
      'DEPLOYMENT_NOT_ROLLBACKABLE',
    );
  });
});
