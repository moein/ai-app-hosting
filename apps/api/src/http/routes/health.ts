import { Hono } from 'hono';
import type { AppEnv } from '../env';

export const healthRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json({ status: 'ok', service: 'api', environment: c.env.ENVIRONMENT }),
);
