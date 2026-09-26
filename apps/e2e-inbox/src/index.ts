import { errorResponse } from '@repo/http';
import { Logger, toPlatformError } from '@repo/shared';
import { parseEnv } from './env';
import { app } from './http/app';
import { storeMessage } from './inbox';

export default {
  fetch(request, env, ctx) {
    try {
      parseEnv(env);
    } catch (error) {
      return errorResponse(toPlatformError(error));
    }
    return app.fetch(request, env, ctx);
  },

  async email(message, env) {
    parseEnv(env);
    const stored = await storeMessage(env.INBOX, {
      to: message.to,
      from: message.from,
      raw: message.raw,
      receivedAt: Date.now(),
    });
    Logger.root.info('e2e inbox received message', { to: stored.to, from: stored.from, id: stored.id });
  },
} satisfies ExportedHandler<Env>;
