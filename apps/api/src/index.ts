import { errorResponse } from '@repo/http';
import { Logger, toPlatformError } from '@repo/shared';
import { createDb } from './db/client';
import { parseEnv } from './env';
import { app } from './http/app';
import { purgeLoginCodes } from './jobs/purge-login-codes';
import { reconcileRoutes } from './jobs/reconcile-routes';

const HOURLY = '0 * * * *';

export { ProvisionApp } from './apps/provision-workflow';
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
    if (controller.cron === HOURLY) {
      Logger.root.info('reconciled app routes', await reconcileRoutes(db, env.APP_ROUTES));
      return;
    }
    const deleted = await purgeLoginCodes(db, controller.scheduledTime);
    Logger.root.info('purged old login codes', { deleted });
  },
} satisfies ExportedHandler<Env>;
