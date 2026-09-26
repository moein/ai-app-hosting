import { createMiddleware } from 'hono/factory';

export type RequestIdVariables = { requestId: string };

/** Global: tags every request with an ID (Cloudflare ray ID when present) and echoes it as `x-request-id`. */
export const requestId = () =>
  createMiddleware<{ Variables: RequestIdVariables }>(async (c, next) => {
    const id = c.req.header('cf-ray') ?? crypto.randomUUID();
    c.set('requestId', id);
    await next();
    c.header('x-request-id', id);
  });
