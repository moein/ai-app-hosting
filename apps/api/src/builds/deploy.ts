import {
  type Clock,
  type Logger,
  MAX_ASSET_FILE_BYTES,
  MAX_ASSET_FILES,
  MAX_WORKER_BUNDLE_BYTES,
  type Metrics,
  PlatformError,
} from '@repo/shared';
import { eq } from 'drizzle-orm';
import { PLATFORM_COMPATIBILITY_DATE } from '../apps/provision';
import type { Db } from '../db/client';
import { apps, deployments } from '../db/schema';
import type { CloudflareClient, ScriptMetadata } from '../integrations/cloudflare';
import type { Environment } from '../platform';
import { buildBindings } from '../runtime/bindings';
import { putRoute, type RouteStore } from '../runtime/routes';
import { fromStepError } from '../workflows/step-errors';
import { type Artifact, gunzip, inspectArtifact, untar } from './artifact';
import { prepareAssets } from './assets';
import { recordDeploymentFinished } from './metrics';
import { applyMigrations } from './migrations';
import { transition } from './state';

export type ArtifactStore = Pick<R2Bucket, 'get' | 'put' | 'delete' | 'list'>;

export type DeployDeps = {
  db: Db;
  cloudflare: CloudflareClient;
  routes: RouteStore;
  artifacts: ArtifactStore;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  environment: Environment;
};

export type DeployParams = { deploymentId: string; artifactKey: string; skipMigrations: boolean };

const COMPAT_MIN = '2026-01-01';

async function loadContext(deps: DeployDeps, params: DeployParams) {
  const deployment = await deps.db.select().from(deployments).where(eq(deployments.id, params.deploymentId)).get();
  if (!deployment) throw new PlatformError('NOT_FOUND', { message: `Deployment ${params.deploymentId} not found.` });
  const app = await deps.db.select().from(apps).where(eq(apps.id, deployment.appId)).get();
  if (!app?.d1DatabaseId) throw new PlatformError('INTERNAL', { message: 'App is not provisioned.' });
  return { deployment, app };
}

async function loadArtifact(deps: DeployDeps, key: string): Promise<Artifact> {
  const object = await deps.artifacts.get(key);
  if (!object) throw new PlatformError('BUILD_FAILED', { message: 'The build artifact is missing.' });
  return inspectArtifact(untar(await gunzip(await object.arrayBuffer())));
}

/** The DeployApp steps (DEP-2.6 – 2.10). Each is safe to retry. */
export function deploySteps(deps: DeployDeps, params: DeployParams) {
  return [
    {
      name: 'migrate',
      run: async () => {
        if (params.skipMigrations) return;
        const { app } = await loadContext(deps, params);
        const artifact = await loadArtifact(deps, params.artifactKey);
        await applyMigrations(deps.cloudflare, app.d1DatabaseId as string, artifact.migrations, deps.clock.now());
      },
    },
    {
      name: 'upload',
      run: async () => {
        const { app } = await loadContext(deps, params);
        const artifact = await loadArtifact(deps, params.artifactKey);
        const bundleBytes = artifact.modules.reduce(
          (n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.byteLength),
          0,
        );
        if (bundleBytes > MAX_WORKER_BUNDLE_BYTES * 3) {
          throw new PlatformError('BUILD_FAILED', {
            message: `The Worker bundle is too large (${bundleBytes} bytes).`,
          });
        }
        if (artifact.assets.size > MAX_ASSET_FILES) {
          throw new PlatformError('BUILD_FAILED', { message: `Too many static files (${artifact.assets.size}).` });
        }
        for (const [path, bytes] of artifact.assets) {
          if (bytes.byteLength > MAX_ASSET_FILE_BYTES) {
            throw new PlatformError('BUILD_FAILED', { message: `Static file ${path} is too large.` });
          }
        }

        const { manifest, byHash } = await prepareAssets(artifact.assets);
        const session = await deps.cloudflare.createAssetsUploadSession(app.scriptName, manifest);
        let completion = session.jwt;
        for (const bucket of session.buckets) {
          const files = Object.fromEntries(
            bucket.map((hash) => [hash, byHash.get(hash) as { base64: string; contentType: string }]),
          );
          const result = await deps.cloudflare.uploadAssetBucket(session.jwt, files);
          if (result.jwt) completion = result.jwt;
        }

        const date = artifact.config.compatibility_date;
        const metadata: ScriptMetadata = {
          main_module: artifact.mainModule,
          compatibility_date:
            date >= COMPAT_MIN && date <= PLATFORM_COMPATIBILITY_DATE ? date : PLATFORM_COMPATIBILITY_DATE,
          compatibility_flags: artifact.config.compatibility_flags,
          bindings: buildBindings(
            {
              appId: app.id,
              orgId: app.orgId,
              slug: app.slug,
              d1DatabaseId: app.d1DatabaseId as string,
              r2BucketName: app.r2BucketName as string,
            },
            { environment: deps.environment, vars: artifact.config.vars, assets: true },
          ),
          keep_bindings: ['secret_text'],
          assets: {
            jwt: completion,
            config: {
              ...(artifact.config.assets.not_found_handling
                ? { not_found_handling: artifact.config.assets.not_found_handling }
                : {}),
              ...(artifact.config.assets.run_worker_first !== undefined
                ? { run_worker_first: artifact.config.assets.run_worker_first }
                : {}),
            },
          },
          tail_consumers: [{ service: `tail-${deps.environment}` }],
          tags: [app.id, app.orgId],
        };
        try {
          await deps.cloudflare.uploadScript(app.scriptName, metadata, artifact.modules);
        } catch (error) {
          throw new PlatformError('DEPLOY_FAILED', { message: 'Publishing the Worker failed.', cause: error });
        }
      },
    },
    {
      name: 'activate',
      run: async () => {
        const { app } = await loadContext(deps, params);
        const now = deps.clock.now();
        if (!(await transition(deps.db, params.deploymentId, ['deploying'], { status: 'succeeded', finishedAt: now })))
          return;
        await recordDeploymentFinished(deps.db, deps.metrics, [params.deploymentId]);
        await deps.db
          .update(apps)
          .set({ liveDeploymentId: params.deploymentId, updatedAt: now })
          .where(eq(apps.id, app.id));
        await putRoute(deps.routes, app.slug, { appId: app.id, scriptName: app.scriptName, state: 'live' });
      },
    },
  ];
}

/** Recovers the PlatformError behind a workflow failure (it crosses step boundaries as JSON). */
const asDeployError = (error: unknown): PlatformError =>
  fromStepError(error) ?? new PlatformError('DEPLOY_FAILED', { cause: error });

/** Marks a deployment failed with the error code/details; the previous live deployment keeps serving. */
export async function markDeploymentFailed(deps: DeployDeps, deploymentId: string, error: unknown) {
  const platformError = asDeployError(error);
  deps.logger.error('deployment failed', { deploymentId, code: platformError.code, error });
  const failed = await transition(deps.db, deploymentId, ['deploying'], {
    status: 'failed',
    errorCode: platformError.code,
    errorDetails: JSON.stringify({ message: platformError.message, ...(platformError.details ?? {}) }).slice(0, 20_000),
    finishedAt: deps.clock.now(),
  });
  if (failed) await recordDeploymentFinished(deps.db, deps.metrics, [deploymentId]);
}

export async function runDeployment(
  deps: DeployDeps,
  params: DeployParams,
  runStep: (name: string, run: () => Promise<void>) => Promise<void> = (_, run) => run(),
): Promise<void> {
  try {
    for (const step of deploySteps(deps, params)) await runStep(step.name, step.run);
  } catch (error) {
    await markDeploymentFailed(deps, params.deploymentId, error);
  }
}
