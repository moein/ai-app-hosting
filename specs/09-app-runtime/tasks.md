# 09 — App Runtime: Tasks

Depends on: 00, 03. Tasks 1–2 are prerequisites for specs 03 (provisioning) and 08 (deploy).

- [x] **1. `CloudflareClient` real implementation + fake**
  Satisfies: (infrastructure for RUN-2, RUN-3, RUN-4, DEP-2)
  Tests: request shapes for each method against recorded fixtures; 429/5xx → `UPSTREAM_ERROR`; 404 on delete → `not_found`.

- [x] **2. `buildBindings` + placeholder script**
  Satisfies: RUN-2.1, RUN-2.2, RUN-2.4
  Tests: binding list exactly matches design (DB id, ASSETS, EMAIL with props, vars); no platform bindings ever present; placeholder upload has zero bindings and returns 503 page (pool-workers).

- [ ] **3. Dispatch namespace + zone setup (dev, prod)**
  Create `apps-<env>` (untrusted), wildcard route, Always Use HTTPS, HSTS; document in runbook; start Public Suffix List submission for `APPS_DOMAIN`.
  Satisfies: RUN-1.1, RUN-1.8, RUN-2.3, RUN-2.5
  Tests: manual — curl http → https redirect; HSTS header present.

- [x] **4. Dispatcher Worker**
  Satisfies: RUN-1.2, RUN-1.3, RUN-1.4, RUN-1.5, RUN-1.6, RUN-1.7
  Tests (pool-workers with a dispatch namespace stub): live → forwarded with limits; not_deployed → 503; missing → 404; deeper subdomain → 404; apex/www → 302 to platform; thrown dispatch → 502 and logged app id.

- [x] **5. KV route reconciliation cron** (in `apps/api`)
  Satisfies: RUN-1.9
  Tests: missing route added; route for deleted app removed; stale state corrected.

- [ ] **6. Schema `app_secrets` + tools `set_secret`, `list_secrets`, `delete_secret`**
  Satisfies: RUN-3.1, RUN-3.2, RUN-3.3, RUN-3.4, RUN-3.5, RUN-3.6, RUN-3.7
  Tests: name validation incl. reserved + var collision; size limit; list has no values (schema-level); delete idempotent; secret count limit; secret persists after a fake redeploy (`keep_bindings` present in upload metadata).

- [ ] **7. `query_database` tool**
  Satisfies: RUN-4.1, RUN-4.2, RUN-4.3, RUN-4.4, RUN-4.5
  Tests: read-only classifier table (SELECT ok; INSERT/UPDATE/DELETE/DROP/WITH rejected without `allow_writes`; `SELECT 1; DROP …` rejected; allowed pragmas only); `_platform_migrations`/`_cf_` writes rejected; truncation by rows and bytes; D1 error → `QUERY_FAILED`.

- [ ] **8. E2E on dev** (spec 12)
  Flows: `F-RUN-1`, `F-RUN-2`, `F-RUN-3`.
  Satisfies: E2E-3.3
