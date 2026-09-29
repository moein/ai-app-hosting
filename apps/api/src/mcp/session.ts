import { Logger, type McpClientInfo, type OrgId, type UserId } from '@repo/shared';
import { McpAgent } from 'agents/mcp';
import { appLogsFor } from '../logs/app-logs';
import { createPlatform } from '../platform';
import { clientInfoFrom, sessionInitializedEvent } from '../tracking/session-events';
import { emitEvent } from '../tracking/track';
import { buildInstructions } from './instructions';
import { TOOLS } from './registry';
import { createMcpServer } from './server';
import type { ToolContext } from './tool';

/** The signed-in user, set by the OAuth provider from the access token (spec 02, AUTH-4). */
export type SessionProps = { userId: UserId; orgId: OrgId; email: string };

/** One Durable Object per MCP session (Mcp-Session-Id); the user comes from the OAuth token's props. */
export class McpSession extends McpAgent<Env, unknown, SessionProps> {
  server = createMcpServer({
    tools: TOOLS,
    instructions: buildInstructions(this.env.APPS_DOMAIN),
    context: () => this.toolContext(),
  });

  #client: McpClientInfo | null | undefined;

  async init(): Promise<void> {}

  /** Called by the agents runtime for each `initialize` (it stores the request); emits EVT-1.2's event. */
  override async setInitializeRequest(request: Parameters<McpAgent['setInitializeRequest']>[0]): Promise<void> {
    await super.setInitializeRequest(request);
    this.#client = clientInfoFrom(request);
    const platform = createPlatform(this.env);
    const logger = Logger.root.child({ worker: 'api', sessionId: this.getSessionId() });
    const client = this.#client;
    platform.metrics.write('session_init', { clientName: client?.name, clientVersion: client?.version });
    this.ctx.waitUntil(
      sessionInitializedEvent({
        sessionId: this.getSessionId(),
        env: platform.environment,
        now: platform.clock.now(),
        client,
      })
        .then((event) => emitEvent({ events: this.env.EVENTS, metrics: platform.metrics, logger }, event))
        .catch((error: unknown) => logger.error('session event failed', { error })),
    );
  }

  private async toolContext(): Promise<ToolContext> {
    const sessionId = this.getSessionId();
    const platform = createPlatform(this.env);
    this.#client ??= clientInfoFrom(await this.getInitializeRequest());
    return {
      env: this.env,
      sessionId,
      logger: Logger.root.child({ worker: 'api', sessionId }),
      clock: platform.clock,
      random: platform.random,
      rateLimiter: this.env.TOOL_RATE_LIMITER,
      db: platform.db,
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
      events: this.env.EVENTS,
      metrics: platform.metrics,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      client: this.#client,
      ...(this.props ? { userId: this.props.userId, orgId: this.props.orgId, email: this.props.email } : {}),
    };
  }
}
