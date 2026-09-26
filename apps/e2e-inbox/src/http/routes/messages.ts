import { PlatformError } from '@repo/shared';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { listMessages } from '../../inbox';
import type { AppEnv } from '../env';

const encoder = new TextEncoder();

/** Group middleware: `Authorization: Bearer <E2E_INBOX_TOKEN>`, compared in constant time. */
const bearerToken = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const given = encoder.encode(c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = encoder.encode(c.env.E2E_INBOX_TOKEN);
    if (given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
      throw new PlatformError('AUTH_REQUIRED', {
        message: 'Missing or invalid inbox token.',
        hint: 'Send Authorization: Bearer <E2E_INBOX_TOKEN>.',
      });
    }
    await next();
  });

const query = z.object({ to: z.email(), since: z.coerce.number().int().nonnegative().default(0) });

export const messagesRoutes = new Hono<AppEnv>().use('*', bearerToken()).get('/', async (c) => {
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) {
    throw new PlatformError('INVALID_INPUT', {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    });
  }
  return c.json({ messages: await listMessages(c.env.INBOX, parsed.data.to, parsed.data.since) });
});
