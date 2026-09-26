import { Logger, type UserId } from '@repo/shared';
import { z } from 'zod';
import { defineTool, type ToolContext } from '../../src/mcp/tool';

export const fakeClock = (start = 1_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

export const testContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  env: {} as Env,
  sessionId: 'session-1',
  logger: new Logger({ test: true }),
  clock: fakeClock(),
  rateLimiter: { limit: async () => ({ success: true }) },
  ...overrides,
});

export const asUser = (id = 'usr_V1StGXR8_Z5') => ({ userId: id as UserId });

export const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes a message.',
  public: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ message: z.string().min(1), times: z.number().int().min(1).default(1) }),
  output: z.object({ echoed: z.string() }),
  handler: async ({ message, times }) => ({ echoed: message.repeat(times) }),
});

export const privateEcho = defineTool({ ...echoTool, name: 'private_echo', public: false });
