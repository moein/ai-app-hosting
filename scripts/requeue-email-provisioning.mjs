#!/usr/bin/env node
// Re-enqueues SES provisioning (spec 11, MAIL-1.4): org tenants and active apps' identities that are `pending` or `failed`.
// Usage: node scripts/requeue-email-provisioning.mjs <dev|prod>   (needs CF_API_TOKEN with D1 + Queues edit in .env.<env>)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../packages/app-contract/src/jsonc.ts';
import { readEnvFile } from './env-file.mjs';

const CF = 'https://api.cloudflare.com/client/v4';
const REQUEUE_STATUSES = new Set(['pending', 'failed']);

export async function requeueEmailProvisioning({ env, token, accountId, databaseId, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${CF}/accounts/${accountId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(`Cloudflare ${method} ${path} → ${JSON.stringify(json.errors)}`);
    return json.result;
  };

  const query = async (sql) => (await call('POST', `/d1/database/${databaseId}/query`, { sql }))[0].results;
  const orgs = await query(
    "SELECT id, email_tenant_status AS status FROM organizations WHERE email_tenant_status IN ('pending', 'failed')",
  );
  const apps = await query(
    "SELECT id, email_status AS status FROM apps WHERE status = 'active' AND email_status IN ('pending', 'failed')",
  );
  const jobs = [
    ...orgs
      .filter((r) => REQUEUE_STATUSES.has(r.status))
      .map((r) => ({ type: 'org.provision_email_tenant', orgId: r.id })),
    ...apps
      .filter((r) => REQUEUE_STATUSES.has(r.status))
      .map((r) => ({ type: 'app.provision_email_identity', appId: r.id })),
  ];
  if (jobs.length === 0) return { orgs: 0, apps: 0 };

  const queues = await call('GET', '/queues');
  const queue = queues.find((q) => q.queue_name === `email-jobs-${env}`);
  if (!queue) throw new Error(`queue email-jobs-${env} not found`);
  for (let i = 0; i < jobs.length; i += 100) {
    const messages = jobs.slice(i, i + 100).map((body) => ({ body, content_type: 'json' }));
    await call('POST', `/queues/${queue.queue_id}/messages/batch`, { messages });
  }
  const orgCount = jobs.filter((j) => j.type === 'org.provision_email_tenant').length;
  return { orgs: orgCount, apps: jobs.length - orgCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2];
  if (env !== 'dev' && env !== 'prod') {
    process.stderr.write('usage: node scripts/requeue-email-provisioning.mjs <dev|prod>\n');
    process.exit(2);
  }
  const config = parseJsonc(readFileSync('apps/api/wrangler.jsonc', 'utf8'));
  const count = await requeueEmailProvisioning({
    env,
    token: readEnvFile(env).CF_API_TOKEN,
    accountId: config.account_id,
    databaseId: config.env[env].d1_databases[0].database_id,
  });
  process.stdout.write(`re-enqueued email provisioning for ${count.orgs} org(s) and ${count.apps} app(s)\n`);
}
