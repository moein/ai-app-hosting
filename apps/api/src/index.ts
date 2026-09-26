import { errorResponse } from '@repo/http';
import { Logger, toPlatformError } from '@repo/shared';
import { createDb } from './db/client';
import { parseEnv } from './env';
import { app } from './http/app';
import { purgeLoginCodes } from './jobs/purge-login-codes';

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
    const deleted = await purgeLoginCodes(createDb(env.DB), controller.scheduledTime);
    Logger.root.info('purged old login codes', { deleted });
  },
} satisfies ExportedHandler<Env>;
