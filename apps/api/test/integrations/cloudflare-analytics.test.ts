import { describe, expect, it } from 'vitest';
import { createCloudflareAnalyticsClient, QUERIES } from '../../src/integrations/cloudflare-analytics';

function client(respond: (body: { query: string; variables: Record<string, string> }) => Response) {
  const bodies: { query: string; variables: Record<string, string> }[] = [];
  const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return respond(body);
  };
  return {
    cf: createCloudflareAnalyticsClient({ apiToken: 't', accountId: 'acct', fetch: fetchImpl as typeof fetch }),
    bodies,
  };
}
const ok = (rows: unknown[]) => Response.json({ data: { viewer: { accounts: [{ rows }] } }, errors: null });
const okAccount = (account: Record<string, unknown>) =>
  Response.json({ data: { viewer: { accounts: [account] } }, errors: null });

describe('CloudflareAnalyticsClient (spec 13 task 2)', () => {
  it('queries a single day per dataset', async () => {
    const { cf, bodies } = client(() => ok([]));
    await cf.d1('2026-09-27');
    expect(bodies[0]).toEqual({ query: QUERIES.d1, variables: { account: 'acct', day: '2026-09-27' } });
    for (const query of Object.values(QUERIES)) expect(query).toContain('date_geq: $day, date_leq: $day');
  });

  it('maps assets, D1 analytics and D1 storage', async () => {
    const responses = [
      [{ dimensions: { hostname: 'todo.motad.app' }, sum: { requests: 7 } }],
      [{ dimensions: { databaseId: 'db1' }, sum: { rowsRead: 100, rowsWritten: 4 } }],
      [{ dimensions: { databaseId: 'db1' }, max: { databaseSizeBytes: 12288 } }],
    ];
    let i = 0;
    const { cf } = client(() => ok(responses[i++] ?? []));
    expect(await cf.assets('2026-09-27')).toEqual([{ hostname: 'todo.motad.app', requests: 7 }]);
    expect(await cf.d1('2026-09-27')).toEqual([{ databaseId: 'db1', rowsRead: 100, rowsWritten: 4 }]);
    expect(await cf.d1Storage('2026-09-27')).toEqual([{ databaseId: 'db1', bytes: 12288 }]);
  });

  it('maps R2 storage', async () => {
    const { cf } = client(() => ok([{ dimensions: { bucketName: 'app-todo-dev' }, max: { payloadSize: 4096 } }]));
    expect(await cf.r2Storage('2026-09-27')).toEqual([{ bucketName: 'app-todo-dev', bytes: 4096 }]);
  });

  it('merges R2 class A and class B operations by bucket, filtered by actionType_in', async () => {
    const { cf, bodies } = client(() =>
      okAccount({
        classA: [
          { dimensions: { bucketName: 'app-todo-dev' }, sum: { requests: 3 } },
          { dimensions: { bucketName: 'app-other-dev' }, sum: { requests: 1 } },
        ],
        classB: [{ dimensions: { bucketName: 'app-todo-dev' }, sum: { requests: 9 } }],
      }),
    );
    const result = await cf.r2Operations('2026-09-27');
    expect(result).toEqual(
      expect.arrayContaining([
        { bucketName: 'app-todo-dev', classA: 3, classB: 9 },
        { bucketName: 'app-other-dev', classA: 1, classB: 0 },
      ]),
    );
    expect(bodies[0]?.query).toContain('actionType_in: $classA');
    expect((bodies[0] as unknown as { variables: { classA: string[]; classB: string[] } }).variables.classA).toContain(
      'PutObject',
    );
    expect((bodies[0] as unknown as { variables: { classA: string[]; classB: string[] } }).variables.classB).toContain(
      'GetObject',
    );
  });

  it.each([
    ['GraphQL errors', () => Response.json({ data: null, errors: [{ message: 'not authorized' }] })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
  ])('maps %s to UPSTREAM_ERROR', async (_, respond) => {
    const { cf } = client(respond);
    await expect(cf.d1('2026-09-27')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
