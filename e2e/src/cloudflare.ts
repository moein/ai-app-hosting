import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../../packages/app-contract/src/jsonc';
import { e2eEnv } from './env';

type Config = { account_id: string; env: { dev: { d1_databases: { database_id: string }[] } } };

/** Account and platform database of dev, from apps/api/wrangler.jsonc. */
export function devConfig() {
  const config = parseJsonc(
    readFileSync(fileURLToPath(new URL('../../apps/api/wrangler.jsonc', import.meta.url)), 'utf8'),
  ) as Config;
  return { accountId: config.account_id, databaseId: config.env.dev.d1_databases[0]?.database_id ?? '' };
}

/** Read-only token for platform data checks (F-USG-1, F-EVT-1). */
export function cfToken(): string {
  const env = e2eEnv();
  const token = env.E2E_CF_API_TOKEN ?? env.CF_API_TOKEN;
  if (!token) throw new Error('E2E_CF_API_TOKEN (or CF_API_TOKEN) is needed for platform data checks');
  return token;
}

/** R2 SQL over the dev data catalog (Iceberg tables in datalake-dev). */
export async function r2Sql<T>(query: string): Promise<T[]> {
  const response = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${devConfig().accountId}/r2-sql/query/datalake-dev`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cfToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    },
  );
  const json = (await response.json()) as { success: boolean; result?: { rows: T[] }; errors: unknown };
  if (!json.success) throw new Error(`R2 SQL failed: ${JSON.stringify(json.errors)}`);
  return json.result?.rows ?? [];
}

/** Analytics Engine SQL over platform_metrics_dev. */
export async function analyticsSql<T>(query: string): Promise<T[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${devConfig().accountId}/analytics_engine/sql`,
    { method: 'POST', headers: { authorization: `Bearer ${cfToken()}` }, body: `${query} FORMAT JSON` },
  );
  if (!response.ok) throw new Error(`Analytics Engine SQL failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: T[] }).data;
}
