import { errorResponse } from '@repo/http';
import { createMetrics, Logger, toPlatformError } from '@repo/shared';
import { createDb } from './db/client';
import { parseEnv } from './env';
import { app } from './http/app';
import { pruneArtifacts, sweepStaleDeployments } from './jobs/build-sweeps';
import { purgeLoginCodes } from './jobs/purge-login-codes';
import { reconcileRoutes } from './jobs/reconcile-routes';

const HOURLY = '0 * * * *';
const EVERY_5_MINUTES = '*/5 * * * *';

export { ProvisionApp } from './apps/provision-workflow';
export { DeployApp } from './builds/deploy-workflow';
export { McpSession } from './mcp/session';

export default {
  fetch(request, env, ctx) {
    // Validate env once, before Hono sees the request; routes read the validated c.env (FND-2.5).
    try {
      parseEnv(env);
    } catch (error) {
      return errorResponse(toPlatformError(error));
    }
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env) {
    parseEnv(env);
    const db = createDb(env.DB);
    if (controller.cron === EVERY_5_MINUTES) {
      const failed = await sweepStaleDeployments(
        db,
        controller.scheduledTime,
        createMetrics(env.METRICS, Logger.root.child({ worker: 'api', job: 'sweeps' })),
      );
      if (failed > 0) Logger.root.info('failed stale deployments', { failed });
      return;
    }
    if (controller.cron === HOURLY) {
      Logger.root.info('reconciled app routes', await reconcileRoutes(db, env.APP_ROUTES));
      return;
    }
    const deleted = await purgeLoginCodes(db, controller.scheduledTime);
    const pruned = await pruneArtifacts(db, env.ARTIFACTS);
    Logger.root.info('daily cleanup', { deletedLoginCodes: deleted, prunedArtifacts: pruned });
  },
} satisfies ExportedHandler<Env>;
