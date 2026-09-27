# 13 — Usage Metering: Design

## Flow

```
api hourly cron ──▶ collectUsage(days = [yesterday, today])
   ├─ Cloudflare GraphQL Analytics (one query per dataset per day)
   │     workersInvocationsAdaptive  (dispatchNamespaceName = apps-<env>, by scriptName)  → requests, cpu_ms, subrequests
   │     workersAssetsRequestsAdaptiveGroups (by hostname <slug>.APPS_DOMAIN)                → asset_requests
   │     d1AnalyticsAdaptiveGroups   (by databaseId)                                        → d1_rows_read, d1_rows_written
   │     d1StorageAdaptiveGroups     (by databaseId, max of day)                            → d1_storage_bytes
   ├─ AppLogBuffer.usage(days) RPC for apps with requests that day                         → log_entries, log_bytes
   ├─ platform D1: deployments                                                              → builds, build_ms, deploys
   │                 retained artifacts (artifact_key not null)                             → artifact_bytes
   ├─ GitHub runs timing for finished deployments without build_billable_ms (USG-1.8)
   └─ upsert app_usage_daily (replace)               AppMail.send ──▶ app_usage_daily emails += recipients
```

All metrics are keyed by `app_id`. Attribution: Worker script name → `apps.script_name`; D1 id → `apps.d1_database_id`; hostname → `<apps.slug>.APPS_DOMAIN`. Rows for scripts, databases and hosts that match no app (platform resources) are ignored. Apps are matched regardless of status, so deleted apps keep reporting storage (USG-1.6).

## Metric catalog (`packages/shared/src/usage.ts`)

| Metric | Unit | Source | Write mode |
|---|---|---|---|
| `requests` | invocations | GraphQL `workersInvocationsAdaptive.sum.requests` | replace |
| `cpu_ms` | ms | GraphQL `sum.cpuTimeUs / 1000` | replace |
| `subrequests` | count | GraphQL `sum.subrequests` | replace |
| `asset_requests` | requests | GraphQL `workersAssetsRequestsAdaptiveGroups.sum.requests` | replace |
| `d1_rows_read` | rows | GraphQL `d1AnalyticsAdaptiveGroups.sum.rowsRead` | replace |
| `d1_rows_written` | rows | GraphQL `sum.rowsWritten` | replace |
| `d1_storage_bytes` | bytes (max of day) | GraphQL `d1StorageAdaptiveGroups.max.databaseSizeBytes` | replace |
| `emails` | recipients sent | `AppMail.send` success | add |
| `log_entries` | entries received | AppLogBuffer daily counter | replace |
| `log_bytes` | bytes of message + stack | AppLogBuffer daily counter | replace |
| `builds` | builds started | deployments with `started_at` that day | replace |
| `build_ms` | billable ms | `deployments.build_billable_ms` of builds finished that day | replace |
| `deploys` | successful deployments | deployments `succeeded` with `finished_at` that day | replace |
| `artifact_bytes` | bytes stored (snapshot) | sum of `artifact_bytes` of deployments whose artifact is still kept | replace |

Only non-zero quantities are stored. "Replace" metrics are recomputed for today and yesterday on every run; "add" metrics are only ever incremented.

## Data model

```sql
CREATE TABLE app_usage_daily (
  app_id     TEXT NOT NULL REFERENCES apps(id),
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  day        TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  metric     TEXT NOT NULL,          -- catalog name
  quantity   REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, day, metric)
);
CREATE INDEX app_usage_daily_org_day ON app_usage_daily (org_id, day);

ALTER TABLE deployments ADD build_billable_ms INTEGER;   -- USG-1.8, null until fetched
```

The replace upsert is `INSERT … ON CONFLICT (app_id, day, metric) DO UPDATE SET quantity = excluded.quantity`; the email add is `… DO UPDATE SET quantity = quantity + excluded.quantity`. Writes are batched (≤ 100 bound parameters per statement).

## Sources

### Cloudflare GraphQL Analytics (`apps/api/src/integrations/cloudflare-analytics.ts`)

`CloudflareAnalyticsClient` with `workers(namespace, day)`, `assets(day)`, `d1(day)`, `d1Storage(day)`, each one query with `limit: 10000` and `date_geq = date_leq = day`, returning rows keyed by script, hostname or database id. It uses `CF_API_TOKEN` (needs *Account Analytics: Read*). GraphQL `errors` or a non-200 → `UPSTREAM_ERROR`. A fake backs tests.

### AppLogBuffer counters (spec 10)

The DO keeps `usage(day TEXT PRIMARY KEY, entries INTEGER, bytes INTEGER)`, incremented in `append` for every received entry (including those dropped by the ingest cap, since we processed them). `bytes` counts the UTF-8 bytes of message and stack of each entry that was stored. The hourly alarm deletes rows older than 7 days. RPC: `usage(days: string[]) → Record<day, { entries, bytes }>`.

### GitHub build time (USG-1.8)

`GitHubClient.getRunBillableMs(repo, runId)` → `GET /repos/{org}/{repo}/actions/runs/{run_id}/timing`, the sum of `billable.*.total_ms` (0 for free minutes on public repos). The collector fetches it for up to 50 deployments per run that have `run_id`, a terminal status, `finished_at` within 2 days and `build_billable_ms` null; a 404 stores 0.

## Pricing (`packages/shared/src/pricing.ts`)

```ts
export const PRICES = {
  asOf: '2026-09-27',
  perUnitUsd: { requests: 0.30e-6, cpu_ms: 0.02e-6, d1_rows_read: 0.001e-6, d1_rows_written: 1.0e-6,
                d1_storage_bytes_month: 0.75 / 1e9, emails: 0.10e-3, build_ms: 0.008 / 60_000,
                artifact_bytes_month: 0.015 / 1e9, log_entries: …, asset_requests: 0, subrequests: 0, … },
  perRequestOverheadUsd: …,   // dispatcher invocation + CPU, KV route read, tail invocation, log DO request
};
export function estimateCostUsd(quantities: Partial<Record<UsageMetric, number>>, days: number): number;
```

List prices after included allowances (Workers for Platforms, D1, SES, GitHub Actions Linux, R2 Standard, Durable Objects, KV); included allowances are account-wide, so per-app estimates ignore them — they are an upper bound. Storage metrics are daily snapshots, priced per GB-month as `Σ(bytes per day) / days-in-month`. Update `asOf` together with the numbers.

## Reports

`scripts/usage-report.mjs <env> [--month YYYY-MM] [--org <org_id>]` reads `app_usage_daily` via the D1 HTTP API (`CF_API_TOKEN`), groups by org and app, prices it with `pricing.ts`, and prints a table sorted by cost. `docs/usage/` has the SQL for ad-hoc queries.

## Metrics (spec 05)

`usage_collected` (blob3 = `ok`/`error`, double2 = duration ms, double3 = rows written) and `usage_collection_failed` (blob2 = source: `workers`, `assets`, `d1`, `d1_storage`, `logs`, `builds`, `github`, `platform`).

## Open questions

1. Show usage to users (`get_usage` with per-app month-to-date quantities)? Needs a product decision on what to expose before plans exist.
2. Soft limits: alert (metric + log) when one app's estimated daily cost exceeds a threshold; later, suspend.
3. Per-org platform overhead (MCP tool calls, provisioning) — track separately from app usage?
4. Roll up days older than 13 months into monthly rows.
