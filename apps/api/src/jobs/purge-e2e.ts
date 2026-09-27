import { type AppLogsRpc, appMailDomain, E2E_PURGE_AFTER_MS, type EmailJob, type Logger } from '@repo/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ArtifactStore } from '../builds/deploy';
import type { Db } from '../db/client';
import {
  appSecrets,
  apps,
  appUsageDaily,
  deployments,
  emailSuppressions,
  loginCodes,
  memberships,
  organizations,
  usageCounters,
  users,
} from '../db/schema';
import type { CloudflareClient } from '../integrations/cloudflare';
import type { GitHubClient } from '../integrations/github';
import { deleteRoute, type RouteStore } from '../runtime/routes';

export type PurgeDeps = {
  db: Db;
  cloudflare: CloudflareClient;
  github: GitHubClient;
  routes: RouteStore;
  artifacts: ArtifactStore;
  appLogs(appId: string): AppLogsRpc;
  emailJobs: { send(job: EmailJob): Promise<unknown> };
  appsDomain: string;
  logger: Logger;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `<local>+%@<domain>` for E2E_INBOX_ADDRESS, or null when it isn't a plain address. */
export function e2eEmailPattern(inboxAddress: string): string | null {
  const match = /^([^@+\s]+)@([^@\s]+)$/.exec(inboxAddress.trim().toLowerCase());
  return match ? `${escapeLike(match[1] as string)}+%@${escapeLike(match[2] as string)}` : null;
}

async function deleteArtifacts(artifacts: ArtifactStore, appId: string) {
  let cursor: string | undefined;
  do {
    const page = await artifacts.list({ prefix: `artifacts/${appId}/`, ...(cursor ? { cursor } : {}) });
    if (page.objects.length > 0) await artifacts.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * E2E-4.2/4.3: hard-purges e2e users (subaddresses of E2E_INBOX_ADDRESS) older than E2E_PURGE_AFTER_MS, dev only.
 * External resources go first; a user's rows are only deleted when all of them are gone, so failures retry next run.
 */
export async function purgeE2eUsers(
  deps: PurgeDeps,
  options: { environment: string; inboxAddress: string | undefined; now: number },
): Promise<{ users: number; apps: number; failed: number }> {
  const result = { users: 0, apps: 0, failed: 0 };
  if (options.environment !== 'dev' || !options.inboxAddress) return result;
  const pattern = e2eEmailPattern(options.inboxAddress);
  if (!pattern) return result;

  const stale = await deps.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(sql`${users.email} LIKE ${pattern} ESCAPE '\\'`, lt(users.createdAt, options.now - E2E_PURGE_AFTER_MS)))
    .all();

  for (const user of stale) {
    const logger = deps.logger.child({ job: 'purge-e2e', userId: user.id });
    const orgIds = (
      await deps.db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, user.id)).all()
    ).map((m) => m.orgId);
    const orgApps = orgIds.length ? await deps.db.select().from(apps).where(inArray(apps.orgId, orgIds)).all() : [];
    try {
      for (const app of orgApps) {
        await deps.cloudflare.deleteScript(app.scriptName);
        await deleteRoute(deps.routes, app.slug);
        if (app.d1DatabaseId) await deps.cloudflare.deleteD1(app.d1DatabaseId);
        await deps.github.deleteRepo(app.repoName);
        await deleteArtifacts(deps.artifacts, app.id);
        await deps.appLogs(app.id).purge();
      }
      for (const orgId of orgIds) {
        const domains = orgApps.filter((a) => a.orgId === orgId).map((a) => appMailDomain(a.slug, deps.appsDomain));
        await deps.emailJobs.send({ type: 'org.purge_email', orgId, domains });
      }
    } catch (error) {
      result.failed++;
      logger.error('e2e purge failed; will retry next run', { error });
      continue;
    }

    const appIds = orgApps.map((a) => a.id);
    await deps.db.batch([
      deps.db.delete(deployments).where(inArray(deployments.appId, appIds.length ? appIds : [''])),
      deps.db.delete(appUsageDaily).where(inArray(appUsageDaily.appId, appIds.length ? appIds : [''])),
      deps.db.delete(appSecrets).where(inArray(appSecrets.appId, appIds.length ? appIds : [''])),
      deps.db.delete(apps).where(inArray(apps.id, appIds.length ? appIds : [''])),
      deps.db.delete(usageCounters).where(inArray(usageCounters.orgId, orgIds.length ? orgIds : [''])),
      deps.db.delete(emailSuppressions).where(inArray(emailSuppressions.orgId, orgIds.length ? orgIds : [''])),
      deps.db.delete(memberships).where(eq(memberships.userId, user.id)),
      deps.db.delete(organizations).where(inArray(organizations.id, orgIds.length ? orgIds : [''])),
      deps.db.delete(loginCodes).where(eq(loginCodes.email, user.email)),
      deps.db.delete(users).where(eq(users.id, user.id)),
    ]);
    result.users++;
    result.apps += orgApps.length;
    logger.info('e2e user purged', { apps: orgApps.length });
  }
  return result;
}
