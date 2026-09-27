import { Logger, type PlatformMailRpc } from '@repo/shared';
import { McpAgent } from 'agents/mcp';
import { createSessionStore } from '../auth/session-store';
import { appLogsFor } from '../logs/app-logs';
import { createPlatform } from '../platform';
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
    const platform = createPlatform(this.env);
    return {
      env: this.env,
      sessionId,
      logger: Logger.root.child({ worker: 'api', sessionId }),
      clock: platform.clock,
      random: platform.random,
      rateLimiter: this.env.TOOL_RATE_LIMITER,
      db: platform.db,
      session: createSessionStore(this.ctx.storage),
      mailer: this.env.MAIL as unknown as PlatformMailRpc,
      emailJobs: this.env.EMAIL_JOBS,
      cloudflare: platform.cloudflare,
      github: platform.github,
      routes: platform.routes,
      provisioner: {
        start: async (appId) => {
          await this.env.PROVISION_APP.create({ id: `provision-${appId}-${Date.now()}`, params: { appId } });
        },
      },
      artifacts: this.env.ARTIFACTS,
      deployer: {
        start: async (params) => {
          await this.env.DEPLOY_APP.create({ id: `deploy-${params.deploymentId}-${Date.now()}`, params });
        },
      },
      appLogs: (appId) => appLogsFor(this.env, appId),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }
}
