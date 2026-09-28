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

  it.each([
    ['GraphQL errors', () => Response.json({ data: null, errors: [{ message: 'not authorized' }] })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
  ])('maps %s to UPSTREAM_ERROR', async (_, respond) => {
    const { cf } = client(respond);
    await expect(cf.d1('2026-09-27')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
