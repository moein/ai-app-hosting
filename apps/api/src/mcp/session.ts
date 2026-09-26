import { Logger, systemClock } from '@repo/shared';
import { McpAgent } from 'agents/mcp';
import { buildInstructions } from './instructions';
import { TOOLS } from './registry';
import { createMcpServer } from './server';
import type { ToolContext } from './tool';

/** One Durable Object per MCP session (Mcp-Session-Id). Session data lives in this.ctx.storage (spec 02). */
export class McpSession extends McpAgent<Env> {
  server = createMcpServer({
    tools: TOOLS,
    instructions: buildInstructions(this.env.APPS_DOMAIN),
    context: () => this.toolContext(),
  });

  async init(): Promise<void> {}

  private toolContext(): ToolContext {
    const sessionId = this.getSessionId();
    return {
      env: this.env,
      sessionId,
      logger: Logger.root.child({ worker: 'api', sessionId }),
      clock: systemClock,
      rateLimiter: this.env.TOOL_RATE_LIMITER,
    };
  }
}
