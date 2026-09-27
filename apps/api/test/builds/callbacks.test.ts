import { errorHandler } from '@repo/http';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { insertApp } from '../../src/apps/insert';
import { clearJwksCache } from '../../src/builds/oidc';
import { apps, deployments } from '../../src/db/schema';
import { createBuildsRoutes } from '../../src/http/routes/builds';
import { signIn, testContext } from '../mcp/helpers';
import { oidcKeys, signOidc, validClaims } from './oidc-helpers';
import { artifactFiles, gzip, makeTar } from './tar';

beforeAll(async () => {
  await oidcKeys();
});
afterEach(() => {
  clearJwksCache();
  vi.restoreAllMocks();
});

let repoIds = 5_000;

async function setup() {
  const ctx = testContext();
  await signIn(ctx);
  const app = await insertApp(ctx, { name: `Build ${Math.random().toString(36).slice(2, 8)}` });
  const repoId = ++repoIds;
  await ctx.db.update(apps).set({ provisioning: 'ready', repoId, d1DatabaseId: 'db-1' }).where(eq(apps.id, app.id));
  const started: unknown[] = [];
  const keys = await oidcKeys();
  const routes = createBuildsRoutes(() => ({
    db: ctx.db,
    artifacts: ctx.artifacts,
    clock: ctx.clock,
    audience: 'https://api.test',
    org: 'AI-app-hosting',
    fetch: keys.fetch,
    startDeploy: async (params) => void started.push(params),
  }));
  const server = new Hono<{ Variables: { requestId: string } }>().route('/v1/builds', routes);
  server.onError(errorHandler());
  const token = (overrides = {}) =>
    signOidc(
      validClaims(ctx.clock.now(), {
        repository_id: String(repoId),
        repository: `AI-app-hosting/${app.repoName}`,
        workflow_ref: `AI-app-hosting/${app.repoName}/.github/workflows/deploy.yml@refs/heads/main`,
        ...overrides,
      }),
    );
  const call = async (path: string, init: RequestInit & { json?: unknown } = {}, claims = {}) =>
    server.request(`/v1/builds${path}`, {
      method: init.method ?? 'POST',
      headers: {
        authorization: `Bearer ${await token(claims)}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? null),
    });
  const queue = async (commit = 'c'.repeat(40)) => {
    const id = `dep_${Math.random().toString(36).slice(2, 13)}`;
    await ctx.db.insert(deployments).values({
      id,
      appId: app.id,
      orgId: app.orgId,
      trigger: 'push',
      commitSha: commit,
      status: 'queued',
      createdAt: ctx.clock.now(),
    });
    return id;
  };
  const status = async (id: string) =>
    (await ctx.db.select().from(deployments).where(eq(deployments.id, id)).get())?.status;
  return { ctx, app, call, queue, status, started };
}

describe('build callbacks (DEP-2.1 – 2.5)', () => {
  it('rejects tokens for another repo or workflow with 401 and changes nothing', async () => {
    const { call, queue, status } = await setup();
    const id = await queue();
    const body = { json: { commit_sha: 'c'.repeat(40), run_id: 1, run_attempt: 1 } };
    expect((await call('/start', body, { repository_id: '1' })).status).toBe(401);
    expect(
      (await call('/start', body, { workflow_ref: 'x/y/.github/workflows/evil.yml@refs/heads/main' })).status,
    ).toBe(401);
    expect((await call('/start', { ...body, headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect(await status(id)).toBe('queued');
  });

  it('start moves the queued deployment to building and cancels older ones (DEP-2.2)', async () => {
    const { call, queue, status } = await setup();
    const older = await queue('a'.repeat(40));
    const current = await queue('c'.repeat(40));
    const res = await call('/start', { json: { commit_sha: 'c'.repeat(40), run_id: 77, run_attempt: 1 } });
    expect(await res.json()).toEqual({ deployment_id: current });
    expect(await status(current)).toBe('building');
    expect(await status(older)).toBe('cancelled');
  });

  it('start creates a deployment for pushes that did not come from write_files', async () => {
    const { ctx, app, call } = await setup();
    const res = await call('/start', { json: { commit_sha: 'd'.repeat(40), run_id: 1, run_attempt: 1 } });
    const { deployment_id } = (await res.json()) as { deployment_id: string };
    expect(await ctx.db.select().from(deployments).where(eq(deployments.id, deployment_id)).get()).toMatchObject({
      appId: app.id,
      trigger: 'push',
      status: 'building',
    });
  });

  it('fail stores violations as CONTRACT_VIOLATION and log tails as BUILD_FAILED (DEP-2.3)', async () => {
    const { ctx, call, queue } = await setup();
    const a = await queue();
    await call('/start', { json: { commit_sha: 'c'.repeat(40), run_id: 1, run_attempt: 1, deployment_id: a } });
    expect((await call(`/${a}/fail`, { json: { step: 'validate', violations: [{ rule: 'CON-R01' }] } })).status).toBe(
      204,
    );
    expect(await ctx.db.select().from(deployments).where(eq(deployments.id, a)).get()).toMatchObject({
      status: 'failed',
      errorCode: 'CONTRACT_VIOLATION',
    });

    const b = await queue('e'.repeat(40));
    await call('/start', { json: { commit_sha: 'e'.repeat(40), run_id: 2, run_attempt: 1, deployment_id: b } });
    await call(`/${b}/fail`, { json: { step: 'build', log_tail: 'x'.repeat(30_000) } });
    const row = await ctx.db.select().from(deployments).where(eq(deployments.id, b)).get();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'BUILD_FAILED' });
    expect((row?.errorDetails ?? '').length).toBeLessThanOrEqual(20_000);
  });

  it('artifact is stored in R2, moves to deploying and starts DeployApp (DEP-2.4)', async () => {
    const { ctx, app, call, queue, started } = await setup();
    const id = await queue();
    await call('/start', { json: { commit_sha: 'c'.repeat(40), run_id: 1, run_attempt: 1 } });
    const body = await gzip(makeTar(artifactFiles()));
    const res = await call(`/${id}/artifact`, { method: 'PUT', body, headers: { 'content-type': 'application/gzip' } });
    expect(res.status).toBe(202);
    const key = `artifacts/${app.id}/${id}.tar.gz`;
    expect(await ctx.artifacts.get(key)).not.toBeNull();
    expect(await ctx.db.select().from(deployments).where(eq(deployments.id, id)).get()).toMatchObject({
      status: 'deploying',
      artifactKey: key,
    });
    expect(started).toEqual([{ deploymentId: id, artifactKey: key, skipMigrations: false }]);
  });

  it('refuses callbacks for cancelled deployments and deleted apps with 409 (DEP-2.5)', async () => {
    const { ctx, app, call, queue } = await setup();
    const id = await queue();
    await ctx.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, id));
    expect(
      (await call('/start', { json: { commit_sha: 'c'.repeat(40), run_id: 1, run_attempt: 1, deployment_id: id } }))
        .status,
    ).toBe(409);
    expect((await call(`/${id}/artifact`, { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(409);
    await ctx.db.update(apps).set({ status: 'deleted' }).where(eq(apps.id, app.id));
    expect((await call(`/${id}/fail`, { json: { step: 'build' } })).status).toBe(409);
  });
});
