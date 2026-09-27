import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requeueEmailTenants } from './requeue-email-tenants.mjs';

function fakeCloudflare(rows) {
  const batches = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith('/query')) result = [{ results: rows }];
    else if (path.endsWith('/queues')) result = [{ queue_name: 'email-jobs-dev', queue_id: 'q1' }];
    else if (path.endsWith('/queues/q1/messages/batch')) {
      batches.push(JSON.parse(init.body).messages);
      result = {};
    } else throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify({ success: true, result }));
  };
  return { fetchImpl, batches };
}

const run = (fake) =>
  requeueEmailTenants({ env: 'dev', token: 't', accountId: 'acct', databaseId: 'db', fetchImpl: fake.fetchImpl });

test('enqueues only pending and failed orgs, in batches of 100', async () => {
  const rows = [
    { id: 'org_ready', email_tenant_status: 'ready' },
    ...Array.from({ length: 150 }, (_, i) => ({ id: `org_${i}`, email_tenant_status: i % 2 ? 'failed' : 'pending' })),
  ];
  const fake = fakeCloudflare(rows);
  assert.equal(await run(fake), 150);
  assert.deepEqual(
    fake.batches.map((b) => b.length),
    [100, 50],
  );
  assert.deepEqual(fake.batches[0][0], {
    body: { type: 'org.provision_email_tenant', orgId: 'org_0' },
    content_type: 'json',
  });
  assert.ok(!fake.batches.flat().some((m) => m.body.orgId === 'org_ready'));
});

test('does nothing when every tenant is ready', async () => {
  const fake = fakeCloudflare([]);
  assert.equal(await run(fake), 0);
  assert.equal(fake.batches.length, 0);
});
