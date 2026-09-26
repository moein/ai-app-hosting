import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/** Global: tags every request with an ID (Cloudflare ray ID when present) and echoes it as `x-request-id`. */
export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const id = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.set('requestId', id);
    await next();
    c.header('x-request-id', id);
  });
