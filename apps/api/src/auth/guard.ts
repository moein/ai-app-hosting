import { PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { ToolMiddleware } from '../mcp/pipeline';

/**
 * Every tool needs the user from the OAuth token (AUTH-4.7): the session sets ctx.userId / ctx.orgId from the
 * token's props; the guard checks the user still exists and isn't blocked.
 */
export const authGuard: ToolMiddleware = async (call, next) => {
  const { userId, db } = call.ctx;
  if (!userId) throw new PlatformError('AUTH_REQUIRED');
  const user = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).get();
  if (!user) throw new PlatformError('AUTH_REQUIRED');
  if (user.status === 'blocked') throw new PlatformError('ACCOUNT_BLOCKED');
  return next();
};
