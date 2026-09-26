# 09 — App Runtime: Design

## Topology

```
Visitor ─▶ https://todo.APPS_DOMAIN/api/items
            │  zone APPS_DOMAIN: route *.APPS_DOMAIN/* → dispatcher-<env>   (Always Use HTTPS, HSTS)
            ▼
       dispatcher-<env>
         host → slug → KV APP_ROUTES.get(slug, { type: 'json', cacheTtl: 30 })
           live         → env.DISPATCHER.get(scriptName, {}, { limits: { cpuMs, subRequests } }).fetch(req)
           not_deployed → 503 page
           missing      → 404 page
           throw        → 502 page + console.error({ appId, error })
            ▼
       dispatch namespace apps-<env> (untrusted)
         script "todo"  bindings: DB → D1 app-todo-<env>, ASSETS, EMAIL → email-<env>/AppMail{props}, vars, secrets
                        tail_consumers: tail-<env>   (spec 10)
```

Dev: `*.dev.APPS_DOMAIN` needs a second-level wildcard certificate (Advanced Certificate Manager) — or use a separate dev apps domain (open question).

## Dispatcher `wrangler.jsonc` (per env)

```jsonc
// apps/dispatcher/wrangler.jsonc
{
  "name": "dispatcher",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-22",
  "env": {
    "dev": {
      "name": "dispatcher-dev",
      "routes": [{ "pattern": "*.dev.APPS_DOMAIN/*", "zone_name": "APPS_DOMAIN" }],
      "vars": { "APPS_DOMAIN": "dev.APPS_DOMAIN", "PLATFORM_WEBSITE_URL": ""  /* empty = apex/www get the 404 page */ },
      "kv_namespaces": [{ "binding": "APP_ROUTES", "id": "…" }],
      "dispatch_namespaces": [{ "binding": "DISPATCHER", "namespace": "apps-dev" }]
    },
    "prod": { "…": "same with prod names" }
  }
}
```

The dispatcher has no D1 binding: routing depends only on KV (written by api on provision/deploy/delete, reconciled hourly — RUN-1.9).

KV value: `{ "appId": "app_…", "scriptName": "todo", "state": "live" | "not_deployed" }`.

## Deployed script bindings (built by `buildBindings(app, artifactConfig)` in `apps/api`)

```json
[
  { "type": "d1", "name": "DB", "id": "<apps.d1_database_id>" },
  { "type": "assets", "name": "ASSETS" },
  { "type": "service", "name": "EMAIL", "service": "email-<env>", "entrypoint": "AppMail",
    "props": { "appId": "app_…", "orgId": "org_…", "slug": "todo" } },
  { "type": "plain_text", "name": "<VAR>", "text": "<value>" }
]
```

Plus `keep_bindings: ["secret_text"]`. Because the platform sets `props`, an app cannot impersonate another app when sending email (spec 11).

## Placeholder script (RUN-2.4)

A tiny module (source in `apps/api/src/runtime/placeholder.ts`, uploaded as a string) returning the 503 HTML. This is platform code, not app code.

## `CloudflareClient` interface (`apps/api/src/integrations/cloudflare.ts`)

```ts
interface CloudflareClient {
  createD1(name: string): Promise<{ id: string }>;
  findD1(name: string): Promise<{ id: string } | null>;
  d1Query(dbId: string, sql: string, params?: unknown[]): Promise<D1QueryResult>;
  uploadScript(name: string, p: { metadata: ScriptMetadata; modules: Module[] }): Promise<void>;
  deleteScript(name: string): Promise<'deleted' | 'not_found'>;
  createAssetsUploadSession(script: string, manifest: AssetManifest): Promise<{ jwt: string; buckets: string[][] }>;
  uploadAssetBucket(jwt: string, files: AssetFile[]): Promise<{ jwt?: string }>;
  putSecret(script: string, name: string, value: string): Promise<void>;
  deleteSecret(script: string, name: string): Promise<'deleted' | 'not_found'>;
}
```

All calls go to `https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/…` (dispatch namespace endpoints for scripts/secrets/assets). 429/5xx → `UPSTREAM_ERROR` (retryable). A fake is used in tests.

## Data model

```sql
CREATE TABLE app_secrets (
  app_id      TEXT NOT NULL REFERENCES apps(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);
```

Values are never stored by the platform — only in the Worker's secret bindings.

## Tool contracts

```ts
set_secret      in { app; name: string; value: string }   out { name; updated_at; next_step: "Read it in code as env.<NAME>." }
list_secrets    in { app }                                out { secrets: { name; updated_at }[] }
delete_secret   in { app; name }                          out { name; deleted: boolean }
query_database  in { app; sql: string; params?: (string|number|null)[]; allow_writes?: boolean }
                out { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean;
                      meta: { rows_read: number; rows_written: number; duration_ms: number } }
```

Read-only check (RUN-4.2): strip comments/whitespace; reject if a `;` is followed by any non-whitespace; first keyword ∈ {`SELECT`, `EXPLAIN`, `PRAGMA`} — and for `PRAGMA` only `table_info`, `table_list`, `index_list`, `index_info`, `foreign_key_list`. `WITH` is allowed only when `allow_writes` is true (a CTE can wrap writes). Guide tip: schema via `SELECT name, sql FROM sqlite_master`.

## Limits

| Constant | Value |
|---|---|
| `APP_CPU_MS_PER_REQUEST` | 100 |
| `APP_SUBREQUESTS_PER_REQUEST` | 50 |
| `MAX_SECRET_BYTES` | 5_120 |
| `MAX_SECRETS_PER_APP` | 50 |
| `QUERY_MAX_ROWS` | 200 |
| `QUERY_MAX_BYTES` | 80_000 |

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `SECRET_NAME_INVALID` | false | Use UPPER_SNAKE_CASE (e.g. `STRIPE_API_KEY`), not `DB`, `ASSETS`, `EMAIL` or an existing var name. |
| `QUERY_FAILED` | false | The database rejected the SQL (`details.message`). Check table/column names with `SELECT name, sql FROM sqlite_master`. |

## Open questions

1. Abuse handling: a `suspended` route state + admin tool to take down phishing/malware apps quickly (needed before public launch).
2. Dev apps domain: second-level wildcard cert on `dev.APPS_DOMAIN` vs. a separate registrable dev domain.
3. Outbound Worker for egress metering / blocking abusive traffic (spam relays, crypto mining endpoints).
4. Per-plan CPU limits once billing exists.
