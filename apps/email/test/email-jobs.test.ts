import { env } from 'cloudflare:workers';
import { type EmailJob, Logger, memoryMetrics } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { SesError } from '../src/integrations/ses';
import { EMAIL_JOB_MAX_RETRIES, type EmailJobDeps, handleEmailJobs, retryDelaySeconds } from '../src/jobs/email-jobs';
import { fakeDns } from './fakes/dns';
import { fakeSes } from './fakes/ses';
import { appEmailStatus, seedApp } from './seed';

const ARN = 'arn:aws:ses:eu-central-1:123456789012';

function deps() {
  const ses = fakeSes();
  const dns = fakeDns();
  const metrics = memoryMetrics();
  const d: EmailJobDeps = {
    db: env.DB,
    ses: ses.client,
    dns: dns.client,
    environment: 'dev',
    region: 'eu-central-1',
    appsDomain: 'motad.app',
    configurationSet: 'apps-dev',
    metrics,
    logger: new Logger({ test: true }),
  };
  return { deps: d, ses, dns, metrics };
}

async function run(d: EmailJobDeps, body: EmailJob, attempts = 1) {
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
  await handleEmailJobs({ queue: 'email-jobs-dev', messages: [message] } as unknown as MessageBatch<EmailJob>, d);
  return outcome;
}
const tenantStatus = async (orgId: string) =>
  (
    await env.DB.prepare('SELECT email_tenant_status AS s FROM organizations WHERE id = ?')
      .bind(orgId)
      .first<{ s: string }>()
  )?.s;

describe('email tenant jobs (MAIL-1.1–1.3)', () => {
  it('creates the tenant with the configuration set and marks the org ready, idempotently', async () => {
    const { deps: d, ses } = deps();
    const { orgId } = await seedApp({ tenant: 'pending' });
    for (let i = 0; i < 2; i++) {
      expect((await run(d, { type: 'org.provision_email_tenant', orgId })).acked).toBe(true);
    }
    expect([...(ses.tenants.get(`dev-${orgId}`) ?? [])]).toEqual([`${ARN}:configuration-set/apps-dev`]);
    expect(await tenantStatus(orgId)).toBe('ready');
  });

  it('retries with backoff, then marks the org failed after the last retry with a metric', async () => {
    const { deps: d, ses, metrics } = deps();
    const { orgId } = await seedApp({ tenant: 'pending' });
    ses.fail('createTenant', new SesError('TooManyRequestsException', 429, 'slow down'));
    expect(await run(d, { type: 'org.provision_email_tenant', orgId }, 1)).toEqual({
      acked: false,
      retried: { delaySeconds: 10 },
    });
    expect(await tenantStatus(orgId)).toBe('pending');
    expect((await run(d, { type: 'org.provision_email_tenant', orgId }, EMAIL_JOB_MAX_RETRIES + 1)).acked).toBe(true);
    expect(await tenantStatus(orgId)).toBe('failed');
    expect(metrics.points).toEqual([
      { event: 'provisioning_failed', fields: { orgId, sub: 'email_tenant', outcome: 'error' } },
    ]);
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
      expect((await run(d, body)).acked).toBe(true);
    }
    expect(ses.tenants.size).toBe(0);
  });
});

describe('per-app email identity (MAIL-1.5–1.8)', () => {
  async function readyTenant(d: EmailJobDeps, options: Parameters<typeof seedApp>[0] = {}) {
    const seeded = await seedApp({ tenant: 'pending', emailStatus: 'pending', ...options });
    await run(d, { type: 'org.provision_email_tenant', orgId: seeded.orgId });
    return seeded;
  }

  it('creates mail.<slug>.APPS_DOMAIN, its DKIM CNAMEs and the tenant association, then waits for verification', async () => {
    const { deps: d, ses, dns } = deps();
    const { appId, orgId, slug } = await readyTenant(d);
    const domain = `mail.${slug}.motad.app`;

    const first = await run(d, { type: 'app.provision_email_identity', appId });
    expect(first).toEqual({ acked: false, retried: { delaySeconds: 10 } }); // DKIM not verified yet
    expect(ses.identities.get(domain)).toEqual({
      verified: false,
      configurationSet: 'apps-dev',
      tags: { app_id: appId, org_id: orgId, env: 'dev' },
    });
    const tokens = (await ses.client.getEmailIdentity(domain))?.dkimTokens ?? [];
    expect(Object.fromEntries(dns.records)).toEqual(
      Object.fromEntries(tokens.map((t) => [`${t}._domainkey.${domain}`, `${t}.dkim.amazonses.com`])),
    );
    expect(ses.tenants.get(`dev-${orgId}`)?.has(`${ARN}:identity/${domain}`)).toBe(true);
    expect(await appEmailStatus(appId)).toBe('pending');

    ses.verify(domain);
    expect((await run(d, { type: 'app.provision_email_identity', appId }, 2)).acked).toBe(true);
    expect(await appEmailStatus(appId)).toBe('ready');
    expect(dns.records.size).toBe(3); // re-run is idempotent
  });

  it('waits for the org tenant before touching SES', async () => {
    const { deps: d, ses } = deps();
    const { appId } = await seedApp({ tenant: 'pending', emailStatus: 'pending' });
    expect((await run(d, { type: 'app.provision_email_identity', appId })).retried).toEqual({ delaySeconds: 10 });
    expect(ses.identities.size).toBe(0);
  });

  it('marks the app failed with a metric when still unverified after the last retry', async () => {
    const { deps: d, metrics } = deps();
    const { appId, orgId } = await readyTenant(d);
    expect((await run(d, { type: 'app.provision_email_identity', appId }, EMAIL_JOB_MAX_RETRIES + 1)).acked).toBe(true);
    expect(await appEmailStatus(appId)).toBe('failed');
    expect(metrics.points).toContainEqual({
      event: 'provisioning_failed',
      fields: { orgId, appId, sub: 'email_identity', outcome: 'error' },
    });
  });

  it('retries on DNS failures and skips deleted or already ready apps', async () => {
    const { deps: d, ses, dns } = deps();
    const { appId } = await readyTenant(d);
    dns.fail(new Error('cloudflare down'));
    expect((await run(d, { type: 'app.provision_email_identity', appId })).retried).not.toBeNull();
    dns.fail(null);

    const identitiesBefore = ses.identities.size;
    const deleted = await readyTenant(d, { appStatus: 'deleted' });
    const ready = await readyTenant(d, { emailStatus: 'ready' });
    for (const app of [deleted, ready]) {
      expect((await run(d, { type: 'app.provision_email_identity', appId: app.appId })).acked).toBe(true);
    }
    expect(ses.identities.size).toBe(identitiesBefore);
  });
});
