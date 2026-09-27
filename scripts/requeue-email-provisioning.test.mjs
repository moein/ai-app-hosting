import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requeueEmailProvisioning } from './requeue-email-provisioning.mjs';

function fakeCloudflare({ orgs = [], apps = [] }) {
  const batches = [];
  const queries = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith('/query')) {
      const { sql } = JSON.parse(init.body);
      queries.push(sql);
      result = [{ results: sql.includes('FROM organizations') ? orgs : apps }];
    } else if (path.endsWith('/queues')) result = [{ queue_name: 'email-jobs-dev', queue_id: 'q1' }];
    else if (path.endsWith('/queues/q1/messages/batch')) {
      batches.push(JSON.parse(init.body).messages);
      result = {};
    } else throw new Error(`unexpected ${path}`);
    return new Response(JSON.stringify({ success: true, result }));
  };
  return { fetchImpl, batches, queries };
}

const run = (fake) =>
  requeueEmailProvisioning({ env: 'dev', token: 't', accountId: 'acct', databaseId: 'db', fetchImpl: fake.fetchImpl });

test('enqueues pending/failed org tenants and app identities, in batches of 100', async () => {
  const orgs = [
    { id: 'org_ready', status: 'ready' },
    ...Array.from({ length: 120 }, (_, i) => ({ id: `org_${i}`, status: i % 2 ? 'failed' : 'pending' })),
  ];
  const apps = [
    { id: 'app_1', status: 'pending' },
    { id: 'app_ready', status: 'ready' },
  ];
  const fake = fakeCloudflare({ orgs, apps });
  assert.deepEqual(await run(fake), { orgs: 120, apps: 1 });
  assert.deepEqual(
    fake.batches.map((b) => b.length),
    [100, 21],
  );
  const bodies = fake.batches.flat().map((m) => m.body);
  assert.deepEqual(bodies[0], { type: 'org.provision_email_tenant', orgId: 'org_0' });
  assert.deepEqual(bodies.at(-1), { type: 'app.provision_email_identity', appId: 'app_1' });
  assert.ok(!bodies.some((b) => b.orgId === 'org_ready' || b.appId === 'app_ready'));
  assert.ok(
    fake.queries.some((q) => q.includes("status = 'active'")),
    'deleted apps are never re-provisioned',
  );
});

test('does nothing when everything is ready', async () => {
  const fake = fakeCloudflare({});
  assert.deepEqual(await run(fake), { orgs: 0, apps: 0 });
  assert.equal(fake.batches.length, 0);
});
