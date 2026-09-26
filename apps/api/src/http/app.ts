import { errorHandler, notFoundHandler, requestId } from '@repo/http';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { healthRoutes } from './routes/health';

/** Every mounted route-group prefix; the main app defines no handlers itself (FND-8.3). */
export const ROUTE_PREFIXES = ['/healthz'] as const;

export const app = new Hono<AppEnv>().use('*', requestId()).route('/healthz', healthRoutes);

app.onError(errorHandler());
app.notFound(notFoundHandler());
