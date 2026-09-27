#!/usr/bin/env node
// Re-enqueues SES tenant provisioning for every org whose email tenant is `pending` or `failed` (spec 11, MAIL-1.4).
// Usage: node scripts/requeue-email-tenants.mjs <dev|prod>   (needs CF_API_TOKEN with D1 + Queues edit in .env.<env>)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../packages/app-contract/src/jsonc.ts';
import { readEnvFile } from './env-file.mjs';

const CF = 'https://api.cloudflare.com/client/v4';
const REQUEUE_STATUSES = new Set(['pending', 'failed']);

export async function requeueEmailTenants({ env, token, accountId, databaseId, fetchImpl = fetch }) {
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

  const [query] = await call('POST', `/d1/database/${databaseId}/query`, {
    sql: "SELECT id, email_tenant_status FROM organizations WHERE email_tenant_status IN ('pending', 'failed')",
  });
  const orgIds = query.results.filter((row) => REQUEUE_STATUSES.has(row.email_tenant_status)).map((row) => row.id);
  if (orgIds.length === 0) return 0;

  const queues = await call('GET', '/queues');
  const queue = queues.find((q) => q.queue_name === `email-jobs-${env}`);
  if (!queue) throw new Error(`queue email-jobs-${env} not found`);
  for (let i = 0; i < orgIds.length; i += 100) {
    const messages = orgIds
      .slice(i, i + 100)
      .map((orgId) => ({ body: { type: 'org.provision_email_tenant', orgId }, content_type: 'json' }));
    await call('POST', `/queues/${queue.queue_id}/messages/batch`, { messages });
  }
  return orgIds.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2];
  if (env !== 'dev' && env !== 'prod') {
    process.stderr.write('usage: node scripts/requeue-email-tenants.mjs <dev|prod>\n');
    process.exit(2);
  }
  const config = parseJsonc(readFileSync('apps/api/wrangler.jsonc', 'utf8'));
  const count = await requeueEmailTenants({
    env,
    token: readEnvFile(env).CF_API_TOKEN,
    accountId: config.account_id,
    databaseId: config.env[env].d1_databases[0].database_id,
  });
  process.stdout.write(`re-enqueued email tenant provisioning for ${count} org(s)\n`);
}
