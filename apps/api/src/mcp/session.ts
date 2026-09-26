import { cryptoRandom, Logger, type PlatformMailRpc, systemClock } from '@repo/shared';
import { McpAgent } from 'agents/mcp';
import { createSessionStore } from '../auth/session-store';
import { createDb } from '../db/client';
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
      random: cryptoRandom,
      rateLimiter: this.env.TOOL_RATE_LIMITER,
      db: createDb(this.env.DB),
      session: createSessionStore(this.ctx.storage),
      mailer: this.env.MAIL as unknown as PlatformMailRpc,
      emailJobs: this.env.EMAIL_JOBS,
    };
  }
}
