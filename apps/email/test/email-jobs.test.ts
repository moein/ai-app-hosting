import { env } from 'cloudflare:workers';
import { type EmailJob, Logger } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { SesError } from '../src/integrations/ses';
import { EMAIL_JOB_MAX_RETRIES, type EmailJobDeps, handleEmailJobs, retryDelaySeconds } from '../src/jobs/email-jobs';
import { fakeSes } from './fakes/ses';
import { seedApp } from './seed';

function deps() {
  const ses = fakeSes();
  const d: EmailJobDeps = {
    db: env.DB,
    ses: ses.client,
    environment: 'dev',
    region: 'eu-central-1',
    appsMailDomain: 'mail.dev.motad.app',
    configurationSet: 'apps-dev',
    logger: new Logger({ test: true }),
  };
  return { deps: d, ses };
}

function batchOf(body: EmailJob, attempts = 1) {
  const outcome = { acked: false, retried: null as null | { delaySeconds?: number } };
  const message = {
    id: 'm1',
    timestamp: new Date(),
    body,
    attempts,
    ack: () => {
      outcome.acked = true;
    },
    retry: (options?: { delaySeconds?: number }) => {
      outcome.retried = options ?? {};
    },
  };
  return { batch: { queue: 'email-jobs-dev', messages: [message] } as unknown as MessageBatch<EmailJob>, outcome };
}
const status = async (orgId: string) =>
  (
    await env.DB.prepare('SELECT email_tenant_status AS s FROM organizations WHERE id = ?')
      .bind(orgId)
      .first<{ s: string }>()
  )?.s;

describe('email tenant jobs (MAIL-1)', () => {
  it('creates the tenant, associates identity and configuration set, and marks the org ready', async () => {
    const { deps: d, ses } = deps();
    const { orgId } = await seedApp({ tenant: 'pending' });
    const { batch, outcome } = batchOf({ type: 'org.provision_email_tenant', orgId });
    await handleEmailJobs(batch, d);
    expect(outcome.acked).toBe(true);
    expect([...(ses.tenants.get(`dev-${orgId}`) ?? [])]).toEqual([
      'arn:aws:ses:eu-central-1:123456789012:identity/mail.dev.motad.app',
      'arn:aws:ses:eu-central-1:123456789012:configuration-set/apps-dev',
    ]);
    expect(await status(orgId)).toBe('ready');
  });

  it('is idempotent: an existing tenant and associations count as success (MAIL-1.2)', async () => {
    const { deps: d } = deps();
    const { orgId } = await seedApp({ tenant: 'pending' });
    for (let i = 0; i < 2; i++) {
      const { batch, outcome } = batchOf({ type: 'org.provision_email_tenant', orgId });
      await handleEmailJobs(batch, d);
      expect(outcome.acked).toBe(true);
    }
    expect(await status(orgId)).toBe('ready');
  });

  it('retries with backoff, then marks the org failed after the last retry (MAIL-1.3)', async () => {
    const { deps: d, ses } = deps();
    const { orgId } = await seedApp({ tenant: 'pending' });
    ses.fail('createTenant', new SesError('TooManyRequestsException', 429, 'slow down'));

    const first = batchOf({ type: 'org.provision_email_tenant', orgId }, 1);
    await handleEmailJobs(first.batch, d);
    expect(first.outcome).toEqual({ acked: false, retried: { delaySeconds: 10 } });
    expect(await status(orgId)).toBe('pending');

    const last = batchOf({ type: 'org.provision_email_tenant', orgId }, EMAIL_JOB_MAX_RETRIES + 1);
    await handleEmailJobs(last.batch, d);
    expect(last.outcome.acked).toBe(true);
    expect(await status(orgId)).toBe('failed');
  });

  it('backs off exponentially up to 15 minutes', () => {
    expect([1, 2, 3, 7, 10].map(retryDelaySeconds)).toEqual([10, 20, 40, 640, 900]);
  });

  it('acks unknown orgs and malformed jobs without calling SES', async () => {
    const { deps: d, ses } = deps();
    for (const body of [
      { type: 'org.provision_email_tenant', orgId: 'org_missing000' },
      { type: 'nope' },
    ] as EmailJob[]) {
      const { batch, outcome } = batchOf(body);
      await handleEmailJobs(batch, d);
      expect(outcome.acked).toBe(true);
    }
    expect(ses.tenants.size).toBe(0);
  });
});
