import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../../packages/app-contract/src/jsonc';
import { e2eEnv } from './env';

type Config = { account_id: string; env: { dev: { d1_databases: { database_id: string }[] } } };

/** Read-only queries against the dev platform D1 through the Cloudflare API (F-USG-1). */
export async function platformQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const env = e2eEnv();
  const token = env.E2E_CF_API_TOKEN ?? env.CF_API_TOKEN;
  if (!token) throw new Error('E2E_CF_API_TOKEN (or CF_API_TOKEN) is needed for platform data checks');
  const config = parseJsonc(
    readFileSync(fileURLToPath(new URL('../../apps/api/wrangler.jsonc', import.meta.url)), 'utf8'),
  ) as Config;
  const db = config.env.dev.d1_databases[0]?.database_id;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${db}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    },
  );
  const json = (await response.json()) as { success: boolean; result: { results: T[] }[]; errors: unknown };
  if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  return json.result[0]?.results ?? [];
}
