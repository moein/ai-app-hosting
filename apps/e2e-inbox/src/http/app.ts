import { errorHandler, notFoundHandler, requestId } from '@repo/http';
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { messagesRoutes } from './routes/messages';

export const ROUTE_PREFIXES = ['/messages'] as const;

export const app = new Hono<AppEnv>().use('*', requestId()).route('/messages', messagesRoutes);

app.onError(errorHandler());
app.notFound(notFoundHandler());
