import { DEPLOY_WORKFLOW_PATH, PLATFORM_JSON_PATH, renderDeployWorkflow, renderPlatformJson } from '@repo/app-contract';
import { type Clock, type Logger, PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apps } from '../db/schema';
import type { CloudflareClient } from '../integrations/cloudflare';
import type { GitHubClient } from '../integrations/github';
import { PLACEHOLDER_MODULE, placeholderMetadata } from '../runtime/placeholder';
import { putRoute, type RouteStore } from '../runtime/routes';

export const PLATFORM_COMPATIBILITY_DATE = '2026-08-22';

export type ProvisionDeps = {
  db: Db;
  cloudflare: CloudflareClient;
  github: GitHubClient;
  routes: RouteStore;
  clock: Clock;
  logger: Logger;
  apiOrigin: string;
};

type Step = { name: string; run: () => Promise<void> };

const decoder = new TextDecoder();

/**
 * The ProvisionApp steps (APP-2.3). Each one is idempotent — it skips resources that already exist — so the
 * workflow can retry any step and `retry_provisioning` can re-run all of them (APP-2.6).
 */
export function provisionSteps(deps: ProvisionDeps, appId: string): Step[] {
  const load = async () => {
    const app = await deps.db.select().from(apps).where(eq(apps.id, appId)).get();
    if (!app) throw new PlatformError('NOT_FOUND', { message: `App ${appId} vanished during provisioning.` });
    return app;
  };
  const save = (values: Partial<typeof apps.$inferInsert>) =>
    deps.db
      .update(apps)
      .set({ ...values, updatedAt: deps.clock.now() })
      .where(eq(apps.id, appId));

  return [
    {
      name: 'd1',
      run: async () => {
        const app = await load();
        if (app.d1DatabaseId) return;
        const existing = await deps.cloudflare.findD1(app.d1DatabaseName);
        const { id } = existing ?? (await deps.cloudflare.createD1(app.d1DatabaseName));
        await save({ d1DatabaseId: id });
      },
    },
    {
      name: 'repo',
      run: async () => {
        const app = await load();
        const repo = app.repoName;
        const existing = await deps.github.getRepo(repo);
        if (existing) {
          const tree = await deps.github.listTree(repo, 'main');
          const platformJson = tree?.files.find((file) => file.path === PLATFORM_JSON_PATH);
          if (platformJson) {
            const owner = JSON.parse(decoder.decode(await deps.github.readBlob(repo, platformJson.sha))) as {
              app?: string;
            };
            if (owner.app !== app.slug) {
              throw new PlatformError('CONFLICT', { message: `Repository ${repo} belongs to another app.` });
            }
          }
        }
        const { id } = existing ?? (await deps.github.createRepo(repo, app.name));
        // Empty repos can't take Git Data API commits, so the first file goes through the contents API.
        if (!(await deps.github.getHead(repo))) {
          await deps.github.putFileOnEmptyRepo(
            repo,
            PLATFORM_JSON_PATH,
            renderPlatformJson({ slug: app.slug, apiOrigin: deps.apiOrigin }),
            'Initialize platform.json [skip ci]',
          );
        }
        const tree = await deps.github.listTree(repo, 'main');
        if (!tree?.files.some((file) => file.path === DEPLOY_WORKFLOW_PATH)) {
          const head = await deps.github.getHead(repo);
          if (!head) throw new PlatformError('INTERNAL', { message: `Repository ${repo} has no main branch.` });
          const commit = await deps.github.commit(repo, {
            parentSha: head.commitSha,
            baseTreeSha: head.treeSha,
            entries: [{ path: DEPLOY_WORKFLOW_PATH, content: renderDeployWorkflow({ apiOrigin: deps.apiOrigin }) }],
            message: 'Add managed deploy workflow [skip ci]',
          });
          if ((await deps.github.updateMain(repo, commit.commitSha)) !== 'ok') {
            throw new PlatformError('CONFLICT', { message: `main moved while provisioning ${repo}.` });
          }
        }
        await save({ repoId: id });
      },
    },
    {
      name: 'script',
      run: async () => {
        const app = await load();
        if (app.liveDeploymentId) return; // never replace a real deployment with the placeholder
        await deps.cloudflare.uploadScript(app.scriptName, placeholderMetadata(PLATFORM_COMPATIBILITY_DATE), [
          PLACEHOLDER_MODULE,
        ]);
      },
    },
    {
      name: 'route',
      run: async () => {
        const app = await load();
        if (app.liveDeploymentId) return;
        await putRoute(deps.routes, app.slug, { appId: app.id, scriptName: app.scriptName, state: 'not_deployed' });
      },
    },
    {
      name: 'ready',
      run: async () => {
        await save({ provisioning: 'ready', provisioningError: null });
      },
    },
  ];
}

/** Marks provisioning failed with the error code after the workflow gave up (APP-2.5). */
export async function markProvisioningFailed(deps: ProvisionDeps, appId: string, error: unknown) {
  const code = error instanceof PlatformError ? error.code : 'INTERNAL';
  deps.logger.error('app provisioning failed', { appId, code, error });
  await deps.db
    .update(apps)
    .set({ provisioning: 'failed', provisioningError: code, updatedAt: deps.clock.now() })
    .where(eq(apps.id, appId));
}

/** Runs every step once, in order (used by tests and as the workflow body with per-step retries). */
export async function runProvisioning(
  deps: ProvisionDeps,
  appId: string,
  runStep: (name: string, run: () => Promise<void>) => Promise<void> = (_, run) => run(),
): Promise<void> {
  try {
    for (const step of provisionSteps(deps, appId)) await runStep(step.name, step.run);
  } catch (error) {
    await markProvisioningFailed(deps, appId, error);
    throw error;
  }
}
