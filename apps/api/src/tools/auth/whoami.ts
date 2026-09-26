import { SESSION_IDLE_TTL_MS } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../../db/schema';
import { defineTool } from '../../mcp/tool';

const LOGGED_OUT = {
  authenticated: false,
  next_step: 'Ask the user for their email address, then call request_login_code.',
};

export const whoami = defineTool({
  name: 'whoami',
  description: 'Shows whether this conversation is logged in, and as which email. Call it first. Works without login.',
  public: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({
    authenticated: z.boolean(),
    email: z.string().optional(),
    member_since: z.string().optional(),
    next_step: z.string().optional(),
  }),
  handler: async (_input, ctx) => {
    const auth = await ctx.session.getAuth();
    if (!auth || ctx.clock.now() - auth.lastSeenAt > SESSION_IDLE_TTL_MS) return LOGGED_OUT;
    const user = await ctx.db.select().from(users).where(eq(users.id, auth.userId)).get();
    if (!user || user.status === 'blocked') return LOGGED_OUT;
    return { authenticated: true, email: user.email, member_since: new Date(user.createdAt).toISOString() };
  },
});
