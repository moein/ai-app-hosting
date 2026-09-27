# 13 — Usage Metering: Tasks

Depends on: 03 (apps), 08 (deployments), 10 (AppLogBuffer), 11 (AppMail), 05 (metrics).

- [ ] **1. Catalog, pricing, schema**
  `packages/shared/src/usage.ts` (metric catalog), `pricing.ts` (`estimateCostUsd`), migration `app_usage_daily` + `deployments.build_billable_ms`.
  Satisfies: USG-1.1 (data), USG-2.1
  Tests: every catalog metric has a price entry; estimate for a known usage matches a hand-computed value; storage metrics prorate per day.

- [ ] **2. `CloudflareAnalyticsClient` + fake**
  Satisfies: USG-1.2 (source)
  Tests: query and variables per dataset (namespace filter, single day, limit); response mapping (cpuTimeUs → ms); GraphQL errors / non-200 → `UPSTREAM_ERROR`.

- [ ] **3. AppLogBuffer usage counters + `usage(days)` RPC**
  Satisfies: USG-1.3 (logs)
  Tests: counts received entries (incl. dropped) and stored bytes per day; old rows removed by the alarm; purge clears them.

- [ ] **4. GitHub run billable time**
  Satisfies: USG-1.8
  Tests: sums billable ms across OSes; 404 → 0; collector fetches only eligible deployments, once.

- [ ] **5. Email usage in `AppMail.send`**
  Satisfies: USG-1.4
  Tests: success adds recipients sent (suppressed not counted); failures add nothing.

- [ ] **6. Hourly collector `collectUsage`**
  Satisfies: USG-1.2, USG-1.3, USG-1.5, USG-1.6, USG-1.7, USG-2.3
  Tests (fakes + real D1): attribution by script / database / hostname; unknown resources ignored; deleted apps keep storage; re-run gives identical rows; yesterday and today collected; `emails` untouched by the collector; one failing source doesn't stop others and writes `usage_collection_failed`; `usage_collected` written.

- [ ] **7. Report script + SQL docs**
  Satisfies: USG-2.2
  Tests: `node --test` — grouping per org/app, month filter, cost sorting with a fake D1 response.

- [ ] **8. E2E on dev** (spec 12)
  Flows: `F-USG-1` (slow): deploy the fixture app, make requests and a D1 query, send one email; within the next collection runs `app_usage_daily` shows `requests`, `cpu_ms`, `d1_rows_*`, `emails`, `builds`, `deploys` and `artifact_bytes` for the app.
  Satisfies: E2E-3.3
