import { errorHandler, notFoundHandler, requestId } from '@repo/http';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { healthRoutes } from './routes/health';
import { mcpRoutes } from './routes/mcp';

/** Every mounted route-group prefix; the main app defines no handlers itself (FND-8.3). */
export const ROUTE_PREFIXES = ['/healthz', '/mcp'] as const;

export const app = new Hono<AppEnv>().use('*', requestId()).route('/healthz', healthRoutes).route('/mcp', mcpRoutes);

app.onError(errorHandler());
app.notFound(notFoundHandler());
