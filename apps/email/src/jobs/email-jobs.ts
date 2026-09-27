import { appMailDomain, type EmailJob, emailTenantName, type Logger, type Metrics } from '@repo/shared';
import { findApp, setAppEmailStatus, setTenantStatus, tenantStatus } from '../db';
import type { DnsClient } from '../integrations/cloudflare-dns';
import type { SesClient } from '../integrations/ses';

/** Matches `max_retries` of the email-jobs consumer in wrangler.jsonc. */
export const EMAIL_JOB_MAX_RETRIES = 10;

export type EmailJobDeps = {
  db: D1Database;
  ses: SesClient;
  dns: DnsClient;
  environment: 'dev' | 'prod';
  region: string;
  appsDomain: string;
  configurationSet: string;
  metrics: Metrics;
  logger: Logger;
};

/** Not an error: the job has to wait (tenant not ready, DKIM not verified yet). */
class NotYet extends Error {}

/** MAIL-1.1/1.2: tenant `<env>-<org>` with the configuration set. Idempotent. */
export async function provisionEmailTenant(deps: EmailJobDeps, orgId: string): Promise<void> {
  const tenant = emailTenantName(deps.environment, orgId);
  const account = await deps.ses.accountId();
  await deps.ses.createTenant(tenant, { org_id: orgId, env: deps.environment });
  await deps.ses.associateTenantResource(
    tenant,
    `arn:aws:ses:${deps.region}:${account}:configuration-set/${deps.configurationSet}`,
  );
  await setTenantStatus(deps.db, orgId, 'ready');
}

/**
 * MAIL-1.6–1.8: the app's own identity `mail.<slug>.APPS_DOMAIN` — create it, publish its DKIM CNAMEs, attach
 * it to the org's tenant, and mark the app ready once SES has verified it. Every step is idempotent.
 */
export async function provisionEmailIdentity(deps: EmailJobDeps, appId: string): Promise<'ready' | 'skipped'> {
  const app = await findApp(deps.db, appId);
  if (app?.status !== 'active' || app.email_status === 'ready') return 'skipped';
  if ((await tenantStatus(deps.db, app.org_id)) !== 'ready') throw new NotYet('org tenant not ready');

  const domain = appMailDomain(app.slug, deps.appsDomain);
  await deps.ses.createEmailIdentity(domain, {
    configurationSet: deps.configurationSet,
    tags: { app_id: appId, org_id: app.org_id, env: deps.environment },
  });
  const identity = await deps.ses.getEmailIdentity(domain);
  if (!identity) throw new Error(`identity ${domain} missing right after creation`);
  for (const token of identity.dkimTokens) {
    await deps.dns.upsertCname(`${token}._domainkey.${domain}`, `${token}.dkim.amazonses.com`);
  }
  const account = await deps.ses.accountId();
  await deps.ses.associateTenantResource(
    emailTenantName(deps.environment, app.org_id),
    `arn:aws:ses:${deps.region}:${account}:identity/${domain}`,
  );
  if (!identity.verified) throw new NotYet('DKIM not verified yet');
  await setAppEmailStatus(deps.db, appId, 'ready');
  return 'ready';
}

/** Dev e2e purge (spec 12): each identity with its DKIM CNAMEs, then the org's tenant. Idempotent. */
export async function purgeOrgEmail(deps: EmailJobDeps, orgId: string, domains: string[]): Promise<void> {
  for (const domain of domains) {
    const identity = await deps.ses.getEmailIdentity(domain);
    for (const token of identity?.dkimTokens ?? []) await deps.dns.deleteCname(`${token}._domainkey.${domain}`);
    await deps.ses.deleteEmailIdentity(domain);
  }
  await deps.ses.deleteTenant(emailTenantName(deps.environment, orgId));
}

/** Exponential backoff: 10 s, 20 s, 40 s … capped at 15 min. */
export const retryDelaySeconds = (attempts: number) => Math.min(10 * 2 ** (attempts - 1), 900);

async function giveUp(deps: EmailJobDeps, job: EmailJob) {
  if (job.type === 'org.purge_email') return; // nothing to record; the purge retries hourly anyway
  if (job.type === 'org.provision_email_tenant') {
    await setTenantStatus(deps.db, job.orgId, 'failed');
    deps.metrics.write('provisioning_failed', { orgId: job.orgId, sub: 'email_tenant', outcome: 'error' });
  } else {
    const app = await findApp(deps.db, job.appId);
    await setAppEmailStatus(deps.db, job.appId, 'failed');
    deps.metrics.write('provisioning_failed', {
      orgId: app?.org_id,
      appId: job.appId,
      sub: 'email_identity',
      outcome: 'error',
    });
  }
}

export async function handleEmailJobs(batch: MessageBatch<EmailJob>, deps: EmailJobDeps): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const logger = deps.logger.child({ job: job?.type, attempts: message.attempts });
    try {
      if (job?.type === 'org.provision_email_tenant' && typeof job.orgId === 'string') {
        if ((await tenantStatus(deps.db, job.orgId)) === null) {
          logger.warn('email tenant job for unknown org', { orgId: job.orgId });
        } else {
          await provisionEmailTenant(deps, job.orgId);
          logger.info('email tenant ready', { orgId: job.orgId });
        }
      } else if (job?.type === 'app.provision_email_identity' && typeof job.appId === 'string') {
        const result = await provisionEmailIdentity(deps, job.appId);
        logger.info('app email identity', { appId: job.appId, result });
      } else if (job?.type === 'org.purge_email' && typeof job.orgId === 'string' && Array.isArray(job.domains)) {
        await purgeOrgEmail(deps, job.orgId, job.domains);
        logger.info('org email purged', { orgId: job.orgId, identities: job.domains.length });
      } else {
        logger.error('unknown email job', {});
      }
      message.ack();
    } catch (error) {
      const waiting = error instanceof NotYet;
      if (message.attempts > EMAIL_JOB_MAX_RETRIES) {
        logger.error('email provisioning failed', { error: waiting ? error.message : error });
        await giveUp(deps, job).catch((e: unknown) => logger.error('could not record failure', { error: e }));
        message.ack();
      } else {
        if (waiting) logger.info('email provisioning waiting', { reason: error.message });
        else logger.warn('email provisioning will retry', { error });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}
