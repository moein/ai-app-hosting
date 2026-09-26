import { ERROR_HTTP_STATUS, Logger, PlatformError, toPlatformError } from '@repo/shared';
import type { Context, ErrorHandler, Env as HonoEnv, NotFoundHandler } from 'hono';
import type { RequestIdVariables } from './request-id';

type WithRequestId = { Variables: RequestIdVariables };

/** The HTTP shape of every PlatformError, also used outside Hono (e.g. env validation in a worker's index.ts). */
export const errorResponse = (error: PlatformError): Response =>
  Response.json({ error: error.toJSON() }, { status: ERROR_HTTP_STATUS[error.code] });

/** Global: maps any thrown error to the PlatformError JSON shape (FND-4); unexpected errors are logged. */
export const errorHandler =
  <E extends HonoEnv & WithRequestId>(): ErrorHandler<E> =>
  (err, c) => {
    const error = toPlatformError(err);
    if (error.code === 'INTERNAL') {
      const requestId = (c as unknown as Context<WithRequestId>).get('requestId');
      Logger.root.error('unhandled error', { requestId, error: error.cause ?? err });
    }
    return errorResponse(error);
  };

export const notFoundHandler =
  <E extends HonoEnv>(): NotFoundHandler<E> =>
  (c) =>
    errorResponse(new PlatformError('NOT_FOUND', { message: `No route for ${c.req.method} ${c.req.path}.` }));
