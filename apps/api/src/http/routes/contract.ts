import { SUPPORTED_CONTRACT_VERSIONS, VALIDATOR_BUNDLE } from '@repo/app-contract';
import { PlatformError } from '@repo/shared';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/** Group middleware: successful responses are immutable per URL (the version is in the path). */
const immutableCache = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    if (c.res.ok) c.header('cache-control', 'public, max-age=31536000, immutable');
  });

/** Public: the bundled contract validator the managed build workflow downloads (spec 06, CON-4.5). */
export const contractRoutes = new Hono<AppEnv>().use('*', immutableCache()).get('/validator/:file', (c) => {
  const version = /^(.+)\.mjs$/.exec(c.req.param('file'))?.[1];
  if (!version || !SUPPORTED_CONTRACT_VERSIONS.includes(version as never)) {
    throw new PlatformError('NOT_FOUND', { message: `No validator for contract version ${version ?? '?'}.` });
  }
  return c.body(VALIDATOR_BUNDLE, 200, { 'content-type': 'text/javascript; charset=utf-8' });
});
