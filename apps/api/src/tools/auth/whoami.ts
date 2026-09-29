import { PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../../db/schema';
import { defineTool } from '../../mcp/tool';

export const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description: 'Shows which account the user signed in with when they connected this server (AUTH-3.6).',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({ email: z.string(), member_since: z.string() }),
  handler: async (_input, ctx) => {
    const user = await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, ctx.userId as string))
      .get();
    if (!user) throw new PlatformError('AUTH_REQUIRED');
    return { email: user.email, member_since: new Date(user.createdAt).toISOString() };
  },
});
