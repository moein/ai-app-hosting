import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { errorResponse } from '@repo/http';
import {
  createMetrics,
  Logger,
  OAUTH_ACCESS_TOKEN_TTL_S,
  OAUTH_REFRESH_TOKEN_TTL_S,
  toPlatformError,
} from '@repo/shared';
import { createDb } from './db/client';
import { parseEnv } from './env';
import { app } from './http/app';
import { pruneArtifacts, sweepStaleDeployments } from './jobs/build-sweeps';
import { purgeE2eUsers } from './jobs/purge-e2e';
import { purgeLoginCodes } from './jobs/purge-login-codes';
import { reconcileRoutes } from './jobs/reconcile-routes';
import { appLogsFor } from './logs/app-logs';
import { McpSession } from './mcp/session';
import { createPlatform } from './platform';
import { collectUsage } from './usage/collect';

const HOURLY = '0 * * * *';
const EVERY_5_MINUTES = '*/5 * * * *';

export { ProvisionApp } from './apps/provision-workflow';
export { DeployApp } from './builds/deploy-workflow';
export { McpSession };

/**
 * OAuth 2.1 authorization server + protected resource for MCP (spec 02, AUTH-4). `/mcp` needs a bearer token; the
 * Hono app serves everything else, including the sign-in pages at /authorize. One instance per API origin.
 */
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(env: Env): OAuthProvider<Env> {
  let provider = providers.get(env.PLATFORM_API_ORIGIN);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: McpSession.serve('/mcp', { binding: 'MCP_SESSION' }),
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['apps'],
      accessTokenTTL: OAUTH_ACCESS_TOKEN_TTL_S,
      refreshTokenTTL: OAUTH_REFRESH_TOKEN_TTL_S,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: `${env.PLATFORM_API_ORIGIN}/mcp`,
        authorization_servers: [env.PLATFORM_API_ORIGIN],
        scopes_supported: ['apps'],
        bearer_methods_supported: ['header'],
        resource_name: 'AI App Hosting',
      },
    });
    providers.set(env.PLATFORM_API_ORIGIN, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    // Validate env once, before Hono sees the request; routes read the validated c.env (FND-2.5).
    try {
      parseEnv(env);
    } catch (error) {
      return errorResponse(toPlatformError(error));
    }
    return providerFor(env).fetch(request, env, ctx);
  },

  async scheduled(controller, env) {
    parseEnv(env);
    const db = createDb(env.DB);
    if (controller.cron === EVERY_5_MINUTES) {
      const failed = await sweepStaleDeployments(
        db,
        controller.scheduledTime,
        createMetrics(env.METRICS, Logger.root.child({ worker: 'api', job: 'sweeps' })),
      );
      if (failed > 0) Logger.root.info('failed stale deployments', { failed });
      return;
    }
    if (controller.cron === HOURLY) {
      // Usage first, so apps purged below still get their last hour recorded (spec 13); then the dev e2e purge
      // (spec 12), then route reconciliation, which no longer needs to consider purged apps.
      const parsed = parseEnv(env);
      const platform = createPlatform(env);
      const appLogs = (appId: string) => appLogsFor(env, appId);
      const usage = await collectUsage({
        ...platform,
        appLogs,
        logger: platform.logger.child({ job: 'usage' }),
        appsDomain: env.APPS_DOMAIN,
      });
      Logger.root.info('collected usage', usage);
      if (parsed.ENVIRONMENT === 'dev' && parsed.E2E_INBOX_ADDRESS) {
        const purged = await purgeE2eUsers(
          { ...platform, artifacts: env.ARTIFACTS, appLogs, appsDomain: env.APPS_DOMAIN },
          { environment: parsed.ENVIRONMENT, inboxAddress: parsed.E2E_INBOX_ADDRESS, now: controller.scheduledTime },
        );
        Logger.root.info('purged e2e users', purged);
      }
      Logger.root.info('reconciled app routes', await reconcileRoutes(db, env.APP_ROUTES));
      return;
    }
    const deleted = await purgeLoginCodes(db, controller.scheduledTime);
    const pruned = await pruneArtifacts(db, env.ARTIFACTS);
    Logger.root.info('daily cleanup', { deletedLoginCodes: deleted, prunedArtifacts: pruned });
  },
} satisfies ExportedHandler<Env>;
