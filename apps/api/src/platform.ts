import { cryptoRandom, Logger, systemClock } from '@repo/shared';
import { dispatchNamespaceFor } from './apps/names';
import type { ProvisionDeps } from './apps/provision';
import { createDb } from './db/client';
import { createCloudflareClient } from './integrations/cloudflare';
import { createGitHubClient } from './integrations/github';

export type Environment = 'dev' | 'prod';

/** Real clients for the platform's own infrastructure, built from the worker env. */
export function createPlatform(env: Env) {
  const environment = env.ENVIRONMENT as Environment;
  return {
    environment,
    db: createDb(env.DB),
    cloudflare: createCloudflareClient({
      apiToken: env.CF_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      dispatchNamespace: dispatchNamespaceFor(environment),
    }),
    github: createGitHubClient({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_INSTALLATION_ID,
      org: env.GITHUB_ORG,
    }),
    routes: env.APP_ROUTES,
    clock: systemClock,
    random: cryptoRandom,
    logger: Logger.root.child({ worker: 'api' }),
    apiOrigin: env.PLATFORM_API_ORIGIN,
  };
}

export type Platform = ReturnType<typeof createPlatform>;

export const provisionDeps = (platform: Pick<Platform, keyof ProvisionDeps>): ProvisionDeps => ({
  db: platform.db,
  cloudflare: platform.cloudflare,
  github: platform.github,
  routes: platform.routes,
  clock: platform.clock,
  logger: platform.logger,
  apiOrigin: platform.apiOrigin,
});
