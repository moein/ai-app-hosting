import { errorResponse } from '@repo/http';
import { toPlatformError } from '@repo/shared';
import { parseEnv } from './env';
import { app } from './http/app';

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
} satisfies ExportedHandler<Env>;
