import { errorHandler, notFoundHandler, requestId } from '@repo/http';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { buildsRoutes } from './routes/builds';
import { contractRoutes } from './routes/contract';
import { healthRoutes } from './routes/health';
import { mcpRoutes } from './routes/mcp';

/** Every mounted route-group prefix; the main app defines no handlers itself (FND-8.3). */
export const ROUTE_PREFIXES = ['/healthz', '/mcp', '/v1/contract', '/v1/builds'] as const;

export const app = new Hono<AppEnv>()
  .use('*', requestId())
  .route('/healthz', healthRoutes)
  .route('/mcp', mcpRoutes)
  .route('/v1/contract', contractRoutes)
  .route('/v1/builds', buildsRoutes);

app.onError(errorHandler());
app.notFound(notFoundHandler());
