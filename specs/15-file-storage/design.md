# 15 — File Storage: Design

## Topology

Extends spec 09's topology: one more per-app Cloudflare resource, provisioned alongside the D1 database and bound alongside `DB`/`ASSETS`/`EMAIL`.

```
ProvisionApp workflow (spec 03)
  d1 step    → CloudflareClient.createD1 / findD1        → apps.d1_database_id
  r2 step    → CloudflareClient.createR2 / findR2         → apps.r2_bucket_name   (this spec)
  repo, script, route, email steps unchanged

Deployed script bindings (apps/api/src/runtime/bindings.ts, buildBindings)
  DB     → d1_databases        { type: "d1", name: "DB", id: <d1_database_id> }
  FILES  → r2_buckets          { type: "r2_bucket", name: "FILES", bucket_name: <r2_bucket_name> }   (this spec)
  ASSETS, EMAIL, vars           unchanged
```

## Data model

```sql
ALTER TABLE apps ADD r2_bucket_name TEXT;   -- null until the r2 provisioning step runs; never deleted (FILE-1.4)
```

`apps/api/src/apps/names.ts` gains `r2BucketName: \`app-${slug}-${environment}\`` alongside `d1DatabaseName` (R2 bucket names allow lowercase letters, digits and hyphens, 3–63 chars — slugs already satisfy this, spec 01).

## `CloudflareClient` additions (`apps/api/src/integrations/cloudflare.ts`)

```ts
createR2(name: string): Promise<{ name: string }>;
findR2(name: string): Promise<{ name: string } | null>;
```

`POST /accounts/{account}/r2/buckets` (create, body `{ name }`), `GET /accounts/{account}/r2/buckets/{name}` (find; 404 → `null`). No `deleteR2`: buckets are kept (FILE-1.4), like `deleteD1` is defined but never called from `delete_app`. 429/5xx → `UPSTREAM_ERROR`, same as every other `CloudflareClient` method. A fake backs tests (extends the existing D1 fake in `test/fakes/cloudflare.ts`).

## Provisioning step (`apps/api/src/apps/provision.ts`)

A `r2` step alongside `d1`, same shape:

```ts
{
  name: 'r2',
  run: async () => {
    const app = await load();
    if (app.r2BucketName) return;
    const existing = await deps.cloudflare.findR2(names.r2BucketName);
    if (!existing) await deps.cloudflare.createR2(names.r2BucketName);
    await save({ r2BucketName: names.r2BucketName });
  },
},
```

(Unlike D1, R2's bucket name *is* its identifier — no separate id to store — so `save` just records the name once creation/lookup succeeds.)

## Contract (`packages/app-contract`)

- `RESERVED_BINDINGS` gains `'FILES'` (validator's `vars` collision check, CON-R10).
- No new entry in `ALLOWED_WRANGLER_KEYS`: an `r2_buckets` key in the app's own `wrangler.jsonc` is already rejected by the existing "unsupported key" rule (CON-R11), exactly like a user-declared `services` or `durable_objects` key today. `FILES` is injected only by `buildBindings`, never written by the app.
- `guide/contract.md`'s injected-bindings list (`ASSETS`, `EMAIL`) gains `FILES: R2Bucket` — apps use it directly, e.g. `await c.env.FILES.put(key, data)`.
- New guide topic (or a section of an existing one — `database.md` is the closest precedent) covering: `env.FILES` is a standard Workers `R2Bucket`; store the key scheme in the app's own D1 table if it needs to list/query uploads by owner; serve a file by having a Hono route call `env.FILES.get(key)` and stream the `Response` back, checking whatever access control the app needs first — buckets are never public on their own.

## Tool contract

```ts
list_storage_objects
  in  { app: string; prefix?: string; cursor?: string }
  out { objects: { key: string; size: number; uploaded_at: string; etag: string }[]; cursor: string | null; truncated: boolean }
```

Read-only, idempotent, no open-world side effect (`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`, matching `list_files`). Calls R2's `list()` with `limit: MAX_STORAGE_LIST_KEYS` and the given `prefix`/`cursor`; `truncated` and the returned `cursor` come straight from R2's own pagination (`listComplete`, `cursor`). `uploaded_at` is the object's `uploaded` timestamp, ISO 8601.

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `MAX_STORAGE_LIST_KEYS` | 200 |

## Usage metering (spec 13 integration)

New metric catalog entries (`packages/shared/src/usage.ts`):

| Metric | Unit | Source | Write mode |
|---|---|---|---|
| `r2_storage_bytes` | bytes (max of day) | GraphQL `r2StorageAdaptiveGroups`, keyed by `bucketName` | replace (snapshot) |
| `r2_class_a_operations` | operations | GraphQL `r2OperationsAdaptiveGroups` (writes: `PutObject`, `ListObjects`, etc.) | replace |
| `r2_class_b_operations` | operations | GraphQL `r2OperationsAdaptiveGroups` (reads: `GetObject`, `HeadObject`) | replace |

`CloudflareAnalyticsClient` (`apps/api/src/integrations/cloudflare-analytics.ts`) gains `r2Storage(day)` and `r2Operations(day)`, following the exact shape of `d1Storage`/`d1`: one GraphQL query per dataset per day, rows keyed by `bucketName` (matched to `apps.r2_bucket_name`, the same attribution style as `d1_database_id`). **Exact GraphQL field names (dataset names, dimension/sum field names for the two R2 datasets) must be confirmed against Cloudflare's current GraphQL schema during implementation** (task 1) — the ones above are best-effort from Cloudflare's documented R2 analytics dimensions and may need adjusting, the same way the existing D1/assets queries were finalized against the real schema rather than written blind.

`collectUsage` (`apps/api/src/usage/collect.ts`) calls both alongside the existing `d1`/`d1Storage` calls, matching apps by `r2_bucket_name` the way it already matches by `d1_database_id`.

Pricing (`packages/shared/src/pricing.ts`), R2 Standard list prices (confirm against Cloudflare's pricing page before shipping, per the file's existing `asOf` convention):

```ts
r2_storage_bytes: 0.015 / 1e9,       // per GB-month — same rate already used for artifact_bytes
r2_class_a_operations: 4.5 / 1e6,    // writes/lists
r2_class_b_operations: 0.36 / 1e6,   // reads
```

Egress is free on R2 (no metric needed).

## Error codes

No new codes: `NOT_FOUND` (FILE-3.3, bucket not provisioned yet), `UPSTREAM_ERROR` (Cloudflare API failures), `INVALID_INPUT` (bad `cursor`) all already exist in the catalog.

## Open questions

1. A `get_storage_object` tool that streams one object's bytes (or a metadata-only HEAD) back to the AI, for inspecting an upload without writing app code — deferred; `list_storage_objects` covers debugging "what's in the bucket" for now.
2. Per-app storage soft limits / alerts, once spec 13's own open question 2 (soft limits generally) is resolved.
3. Whether to expose R2's conditional operations (`onlyIf`, checksums) in the guide, or leave apps to the standard `R2Bucket` API docs.
