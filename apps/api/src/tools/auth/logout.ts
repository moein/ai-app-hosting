import { z } from 'zod';
import { defineTool } from '../../mcp/tool';

export const logout = defineTool({
  name: 'logout',
  description: 'Logs this conversation out. Tools that need an account will ask for a new login afterwards.',
  public: false,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({}),
  output: z.object({ authenticated: z.literal(false) }),
  handler: async (_input, ctx) => {
    await ctx.session.clearAuth();
    return { authenticated: false as const };
  },
});
