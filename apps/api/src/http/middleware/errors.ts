import { ERROR_HTTP_STATUS, Logger, PlatformError, toPlatformError } from '@repo/shared';
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from '../env';

/** Global: maps any thrown error to the PlatformError JSON shape (FND-4). */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const error = toPlatformError(err);
  if (error.code === 'INTERNAL') {
    Logger.root.error('unhandled error', { requestId: c.get('requestId'), error: error.cause ?? err });
  }
  return errorResponse(error);
};

/** The HTTP shape of every PlatformError, also used outside Hono (e.g. env validation in index.ts). */
export const errorResponse = (error: PlatformError): Response =>
  Response.json({ error: error.toJSON() }, { status: ERROR_HTTP_STATUS[error.code] });

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json(
    { error: new PlatformError('NOT_FOUND', { message: `No route for ${c.req.method} ${c.req.path}.` }).toJSON() },
    404,
  );
