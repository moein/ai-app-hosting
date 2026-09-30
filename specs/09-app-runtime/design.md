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
         script "todo"  bindings: DB → D1 app-todo-<env>, FILES → R2 app-todo-<env>, ASSETS, EMAIL → email-<env>/AppMail{props}, AUTH → email-<env>/AppAuth{props} (spec 16), AI → ai-<env>/AppAi{props} (spec 18), REALTIME → realtime-<env>/AppRealtime{props} (spec 21), vars, secrets
                        tail_consumers: tail-<env>   (spec 10)
```

Each environment has its own `APPS_DOMAIN` zone, and apps are one level below its apex (`<slug>.APPS_DOMAIN`), so the zone's Universal SSL certificate (apex + `*.APPS_DOMAIN`) covers every app — no Advanced Certificate needed. Deeper names under an app (`mail.<slug>.APPS_DOMAIN`, spec 11) only carry DNS records for email, never HTTP.

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
      "routes": [{ "pattern": "*.APPS_DOMAIN/*", "zone_name": "APPS_DOMAIN" }, { "pattern": "APPS_DOMAIN/*", "zone_name": "APPS_DOMAIN" }],
      "vars": { "APPS_DOMAIN": "APPS_DOMAIN", "PLATFORM_WEBSITE_URL": ""  /* empty = apex/www get the 404 page */ },
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
  { "type": "r2_bucket", "name": "FILES", "bucket_name": "<apps.r2_bucket_name>" },
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

`createR2`/`findR2` (the app's bucket, spec 15) follow the same shape and error handling; see spec 15's design for their signatures.

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

`query_database` sends the single comment-stripped statement to D1's `/raw` endpoint. D1 answers bad SQL with HTTP 400, which becomes `QUERY_FAILED` with D1's message; any other Cloudflare failure (429/5xx, auth) stays `UPSTREAM_ERROR`. Results over `QUERY_MAX_ROWS` / `QUERY_MAX_BYTES` are cut from the end (`row_count` is the full count).

The var-collision check (RUN-3.2) reads `vars` from the live deployment's artifact config (`dist/app/wrangler.json`); with no live deployment there are no vars to collide with. `set_secret` checks the name before any Cloudflare call.

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

## Cookie isolation (RUN-5, `apps/dispatcher/src/cookies.ts`)

Applied only on the dispatch path (live apps); platform pages set no cookies.

```
request → drop Cookie entirely if Sec-Fetch-Site = same-site
        → otherwise keep pairs named "__Host-<name>" → forward as "<name>" (one prefix stripped); others dropped
response ← for each Set-Cookie (headers.getSetCookie()):
             "<name>=<value>; attrs" → "__Host-<name>=<value>; <attrs without Domain/Path/Secure>; Path=/; Secure"
         ← Origin-Agent-Cluster: ?1
```

Always prefixing (also names that already start with `__Host-`) keeps the round trip exact: the app sets `sid`, the browser stores `__Host-sid`, the app reads `sid`. A cookie planted with `Domain=APPS_DOMAIN` (by another app's server or browser JS) can't carry the `__Host-` prefix — browsers refuse `__Host-` cookies with a `Domain` — so it never reaches an app. A link from another app (`same-site`) arrives without cookies, like a cross-site request; links from any other site behave normally.

Remaining gap without the PSL: browser features keyed on "site" (e.g. reputation lists, storage partitioning heuristics). Submitting the prod domain to the PSL stays optional (≥ 2 years of registration needed).

## Open questions

1. Abuse handling: a `suspended` route state + admin tool to take down phishing/malware apps quickly (needed before public launch).
2. ~~Dev apps domain~~ — decided (2026-09-27): dev and prod each have their own `APPS_DOMAIN` zone; apps sit directly under its apex, covered by Universal SSL.
3. Outbound Worker for egress metering / blocking abusive traffic (spam relays, crypto mining endpoints).
4. Per-plan CPU limits once billing exists.
