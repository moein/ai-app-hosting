import type { WorkerBinding } from '../integrations/cloudflare';

export type AppIdentity = { appId: string; orgId: string; slug: string; d1DatabaseId: string };

/**
 * Exactly the bindings an app script gets (RUN-2.1, RUN-2.2): its own D1, its static assets, the EMAIL service
 * (identity fixed by platform-set props) and its string vars. Never anything of the platform's.
 */
export function buildBindings(
  app: AppIdentity,
  options: { environment: 'dev' | 'prod'; vars?: Record<string, string>; assets: boolean },
): WorkerBinding[] {
  return [
    { type: 'd1', name: 'DB', id: app.d1DatabaseId },
    ...(options.assets ? [{ type: 'assets', name: 'ASSETS' } as const] : []),
    {
      type: 'service',
      name: 'EMAIL',
      service: `email-${options.environment}`,
      entrypoint: 'AppMail',
      props: { appId: app.appId, orgId: app.orgId, slug: app.slug },
    },
    ...Object.entries(options.vars ?? {}).map(([name, text]) => ({ type: 'plain_text', name, text }) as const),
  ];
}
