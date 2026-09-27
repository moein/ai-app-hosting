import { type Clock, MAX_ARTIFACT_BYTES, type Metrics, newId, PlatformError } from '@repo/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { consumeDaily } from '../../apps/quota';
import type { AppRow } from '../../apps/resolve';
import type { ArtifactStore, DeployParams } from '../../builds/deploy';
import { recordDeploymentFinished } from '../../builds/metrics';
import { checkBuildClaims, type GitHubOidcClaims, verifyGitHubOidc } from '../../builds/oidc';
import { cancelOthers, transition } from '../../builds/state';
import type { Db } from '../../db/client';
import { apps, deployments } from '../../db/schema';
import { createPlatform } from '../../platform';
import type { AppEnv } from '../env';

export type BuildsDeps = {
  db: Db;
  artifacts: ArtifactStore;
  clock: Clock;
  metrics: Metrics;
  audience: string;
  org: string;
  startDeploy(params: DeployParams): Promise<void>;
  fetch?: typeof fetch;
};

type BuildsEnv = AppEnv & { Variables: { build: { app: AppRow; claims: GitHubOidcClaims } } };

const StartBody = z.object({
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  run_id: z.coerce.number().int(),
  run_attempt: z.coerce.number().int(),
  job_id: z.coerce.number().int().optional(),
  deployment_id: z.string().optional(),
});
const FailBody = z.object({
  step: z.enum(['start', 'validate', 'install', 'typecheck', 'build', 'package', 'upload']),
  violations: z.array(z.unknown()).optional(),
  log_tail: z.string().optional(),
});

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PlatformError('INVALID_INPUT', {
      details: { issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  return result.data;
};

const conflict = (message: string) =>
  new PlatformError('CONFLICT', { message, hint: 'This build is no longer current.' });

/** Build callbacks from the managed workflow (spec 08, DEP-2), authenticated with GitHub OIDC (DEP-2.1). */
export function createBuildsRoutes(depsFor: (env: Env) => BuildsDeps) {
  const oidcAuth = () =>
    createMiddleware<BuildsEnv>(async (c, next) => {
      const deps = depsFor(c.env);
      const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const claims = await verifyGitHubOidc(token, {
        audience: deps.audience,
        now: deps.clock.now(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      const app = await deps.db
        .select()
        .from(apps)
        .where(eq(apps.repoId, Number(claims.repository_id)))
        .get();
      if (!app) throw new PlatformError('AUTH_REQUIRED', { message: 'Unknown repository.' });
      checkBuildClaims(claims, { org: deps.org, repo: app.repoName, repoId: app.repoId as number });
      if (app.status === 'deleted') throw conflict('The app was deleted.');
      c.set('build', { app, claims });
      await next();
    });

  const deploymentOf = async (db: Db, appId: string, id: string) => {
    const row = await db
      .select()
      .from(deployments)
      .where(and(eq(deployments.id, id), eq(deployments.appId, appId)))
      .get();
    if (!row) throw new PlatformError('NOT_FOUND', { message: `Deployment ${id} not found.` });
    return row;
  };

  return new Hono<BuildsEnv>()
    .use('*', oidcAuth())
    .post('/start', async (c) => {
      const deps = depsFor(c.env);
      const { app } = c.get('build');
      const body = parse(StartBody, await c.req.json());
      const now = deps.clock.now();
      let deployment = body.deployment_id
        ? await deploymentOf(deps.db, app.id, body.deployment_id)
        : await deps.db
            .select()
            .from(deployments)
            .where(
              and(
                eq(deployments.appId, app.id),
                eq(deployments.commitSha, body.commit_sha),
                eq(deployments.status, 'queued'),
              ),
            )
            .orderBy(desc(deployments.createdAt))
            .get();
      if (!deployment) {
        // A push that didn't come from write_files still deploys, and still counts (spec 08 design).
        await consumeDaily(deps.db, app.orgId, 'deploys', now);
        deployment = await deps.db
          .insert(deployments)
          .values({
            id: newId('dep'),
            appId: app.id,
            orgId: app.orgId,
            trigger: 'push',
            commitSha: body.commit_sha,
            status: 'queued',
            createdAt: now,
          })
          .returning()
          .get();
      }
      const started = await transition(deps.db, deployment.id, ['queued'], {
        status: 'building',
        startedAt: now,
        runId: body.run_id,
        runAttempt: body.run_attempt,
        jobId: body.job_id ?? null,
        commitSha: body.commit_sha,
      });
      if (!started) throw conflict(`Deployment ${deployment.id} is ${deployment.status}.`);
      await recordDeploymentFinished(deps.db, deps.metrics, await cancelOthers(deps.db, app.id, deployment.id, now));
      return c.json({ deployment_id: deployment.id });
    })
    .post('/:deployment/fail', async (c) => {
      const deps = depsFor(c.env);
      const { app } = c.get('build');
      const deployment = await deploymentOf(deps.db, app.id, c.req.param('deployment'));
      const body = parse(FailBody, await c.req.json());
      const contract = body.step === 'validate' && body.violations !== undefined;
      const details = JSON.stringify({
        step: body.step,
        ...(contract ? { violations: body.violations } : { log_tail: (body.log_tail ?? '').slice(-20_000) }),
      });
      const failed = await transition(deps.db, deployment.id, ['queued', 'building'], {
        status: 'failed',
        errorCode: contract ? 'CONTRACT_VIOLATION' : 'BUILD_FAILED',
        errorDetails: details.slice(0, 20_000),
        finishedAt: deps.clock.now(),
      });
      if (!failed) throw conflict(`Deployment ${deployment.id} is ${deployment.status}.`);
      await recordDeploymentFinished(deps.db, deps.metrics, [deployment.id]);
      return c.body(null, 204);
    })
    .put('/:deployment/artifact', async (c) => {
      const deps = depsFor(c.env);
      const { app } = c.get('build');
      const deployment = await deploymentOf(deps.db, app.id, c.req.param('deployment'));
      if (deployment.status !== 'building') throw conflict(`Deployment ${deployment.id} is ${deployment.status}.`);
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_ARTIFACT_BYTES)
        throw new PlatformError('PAYLOAD_TOO_LARGE', { details: { max_bytes: MAX_ARTIFACT_BYTES } });
      const body = await c.req.arrayBuffer();
      if (body.byteLength > MAX_ARTIFACT_BYTES)
        throw new PlatformError('PAYLOAD_TOO_LARGE', { details: { max_bytes: MAX_ARTIFACT_BYTES } });

      const key = `artifacts/${app.id}/${deployment.id}.tar.gz`;
      await deps.artifacts.put(key, body);
      const now = deps.clock.now();
      const moved = await transition(deps.db, deployment.id, ['building'], {
        status: 'deploying',
        artifactKey: key,
        artifactBytes: body.byteLength,
        buildFinishedAt: now,
      });
      if (!moved) {
        await deps.artifacts.delete(key);
        throw conflict(`Deployment ${deployment.id} is no longer building.`);
      }
      await deps.startDeploy({ deploymentId: deployment.id, artifactKey: key, skipMigrations: false });
      return c.body(null, 202);
    });
}

/** Production wiring: real D1/R2 and the DeployApp workflow. */
export const buildsRoutes = createBuildsRoutes((env) => {
  const platform = createPlatform(env);
  return {
    db: platform.db,
    artifacts: env.ARTIFACTS,
    clock: platform.clock,
    metrics: platform.metrics,
    audience: env.PLATFORM_API_ORIGIN,
    org: env.GITHUB_ORG,
    startDeploy: async (params) => {
      await env.DEPLOY_APP.create({ id: `deploy-${params.deploymentId}-${Date.now()}`, params });
    },
  };
});
