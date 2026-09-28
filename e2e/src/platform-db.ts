import { cfToken, devConfig } from './cloudflare';

/** Read-only queries against the dev platform D1 through the Cloudflare API (F-USG-1). */
export async function platformQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { accountId, databaseId } = devConfig();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cfToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = (await response.json()) as { success: boolean; result: { results: T[] }[]; errors: unknown };
  if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  return json.result[0]?.results ?? [];
}
