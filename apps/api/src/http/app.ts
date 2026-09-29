import { errorHandler, notFoundHandler, requestId } from '@repo/http';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { authorizeRoutes } from './routes/authorize';
import { buildsRoutes } from './routes/builds';
import { contractRoutes } from './routes/contract';
import { healthRoutes } from './routes/health';
import { sesRoutes } from './routes/ses';

/**
 * Every mounted route-group prefix; the main app defines no handlers itself (FND-8.3). `/mcp` and the OAuth
 * endpoints are served by the OAuth provider in front of this app (src/index.ts).
 */
export const ROUTE_PREFIXES = ['/healthz', '/authorize', '/v1/contract', '/v1/builds', '/v1/ses'] as const;

export const app = new Hono<AppEnv>()
  .use('*', requestId())
  .route('/healthz', healthRoutes)
  .route('/authorize', authorizeRoutes)
  .route('/v1/contract', contractRoutes)
  .route('/v1/builds', buildsRoutes)
  .route('/v1/ses', sesRoutes);

app.onError(errorHandler());
app.notFound(notFoundHandler());
