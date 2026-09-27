import { type EmailJob, emailTenantName, type Logger } from '@repo/shared';
import { setTenantStatus, tenantStatus } from '../db';
import type { SesClient } from '../integrations/ses';

/** Matches `max_retries` of the email-jobs consumer in wrangler.jsonc. */
export const EMAIL_JOB_MAX_RETRIES = 10;

export type EmailJobDeps = {
  db: D1Database;
  ses: SesClient;
  environment: 'dev' | 'prod';
  region: string;
  appsMailDomain: string;
  configurationSet: string;
  logger: Logger;
};

/** MAIL-1.1/1.2: tenant `<env>-<org>`, associated with the domain identity and configuration set. Idempotent. */
export async function provisionEmailTenant(deps: EmailJobDeps, orgId: string): Promise<void> {
  const tenant = emailTenantName(deps.environment, orgId);
  const account = await deps.ses.accountId();
  const arn = (resource: string) => `arn:aws:ses:${deps.region}:${account}:${resource}`;
  await deps.ses.createTenant(tenant, { org_id: orgId, env: deps.environment });
  await deps.ses.associateTenantResource(tenant, arn(`identity/${deps.appsMailDomain}`));
  await deps.ses.associateTenantResource(tenant, arn(`configuration-set/${deps.configurationSet}`));
  await setTenantStatus(deps.db, orgId, 'ready');
}

/** Exponential backoff: 10 s, 20 s, 40 s … capped at 15 min. */
export const retryDelaySeconds = (attempts: number) => Math.min(10 * 2 ** (attempts - 1), 900);

export async function handleEmailJobs(batch: MessageBatch<EmailJob>, deps: EmailJobDeps): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const logger = deps.logger.child({ job: job?.type, orgId: job?.orgId, attempts: message.attempts });
    if (job?.type !== 'org.provision_email_tenant' || typeof job.orgId !== 'string') {
      logger.error('unknown email job', {});
      message.ack();
      continue;
    }
    try {
      if ((await tenantStatus(deps.db, job.orgId)) === null) {
        logger.warn('email tenant job for unknown org', {});
        message.ack();
        continue;
      }
      await provisionEmailTenant(deps, job.orgId);
      logger.info('email tenant ready', {});
      message.ack();
    } catch (error) {
      if (message.attempts > EMAIL_JOB_MAX_RETRIES) {
        // MAIL-1.3; the provisioning_failed metric is written here once spec 05's metrics helper exists.
        logger.error('email tenant provisioning failed', { error });
        await setTenantStatus(deps.db, job.orgId, 'failed').catch(() => {});
        message.ack();
      } else {
        logger.warn('email tenant provisioning will retry', { error });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}
