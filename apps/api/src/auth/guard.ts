import { PlatformError, SESSION_IDLE_TTL_MS } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import type { ToolMiddleware } from '../mcp/pipeline';

/**
 * Public tools always run (AUTH-3.3). Others need a live session binding (sliding 30-day expiry, AUTH-3.2)
 * for a user who isn't blocked (AUTH-3.7); the guard then sets ctx.userId / ctx.orgId.
 */
export const authGuard: ToolMiddleware = async (call, next) => {
  if (call.tool.public) return next();
  const { session, db, clock } = call.ctx;
  const auth = await session.getAuth();
  const now = clock.now();
  if (!auth || now - auth.lastSeenAt > SESSION_IDLE_TTL_MS) {
    if (auth) await session.clearAuth();
    throw new PlatformError('AUTH_REQUIRED');
  }
  const user = await db.select({ status: users.status }).from(users).where(eq(users.id, auth.userId)).get();
  if (!user || user.status === 'blocked') {
    await session.clearAuth();
    throw new PlatformError(user ? 'ACCOUNT_BLOCKED' : 'AUTH_REQUIRED');
  }
  await session.setAuth({ ...auth, lastSeenAt: now });
  call.ctx.userId = auth.userId;
  call.ctx.orgId = auth.orgId;
  return next();
};
