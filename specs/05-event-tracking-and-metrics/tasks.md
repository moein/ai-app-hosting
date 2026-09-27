# 05 — Event Tracking & Metrics: Tasks

Depends on: 00, 04 (task 2 middleware chain).

- [ ] **1. Provision stream, pipeline, sink (dev + prod)**
  Create `mcp-events-<env>` stream with schema, pipeline, R2 Data Catalog sink `mcp_events` in `datalake-<env>`; add `EVENTS` binding to `apps/api/wrangler.jsonc`. Same for the runtime-log archive (spec 10): `app-logs-<env>` stream + sink table `app_logs`, and the `LOG_ARCHIVE` binding in `apps/tail/wrangler.jsonc`. Record commands in `docs/runbook.md`. Needs R2 enabled on the account.
  Satisfies: EVT-1.7, LOG-2.6 (infrastructure)
  Tests: manual — send a test event in dev and query it with R2 SQL / catalog.

- [ ] **2. Event schema + redaction + capping**
  Satisfies: EVT-1.3, EVT-1.4, EVT-1.5, EVT-1.8
  Tests: redactor per tool; catalog-wide sensitive-field guard test; 8 KB cap sets flag; session id is hashed; snapshot has no raw code/secret/content.

- [ ] **3. `track` middleware**
  Satisfies: EVT-1.1, EVT-1.6
  Tests (pool-workers, fake `EVENTS`): exactly one event per call for ok, handler error, `AUTH_REQUIRED`, `INVALID_INPUT`, `RATE_LIMITED`; failing `EVENTS.send` doesn't fail the tool and writes `event_emit_failed`.

- [ ] **4. Session-initialized event + client info capture**
  Satisfies: EVT-1.2
  Tests: initialize emits event with client name/version; later tool events carry them.

- [ ] **5. Metrics helper**
  `metrics.write(name, fields)` with typed slots; swallow errors.
  Satisfies: EVT-2.6, EVT-2.7, EVT-2.1
  Tests: slot mapping per event; `index1` = `anon` when no org; throwing AE binding doesn't propagate.

- [ ] **6. Wire feature metrics** (as features land)
  Satisfies: EVT-2.2 (spec 02 task 8), EVT-2.3 (spec 03), EVT-2.4 (spec 08), EVT-2.5 (spec 11)
  Tests: in each feature's tests, assert the fake AE received the data point.

- [ ] **7. `docs/metrics/*.sql`**
  Satisfies: EVT non-functional
  Tests: manual run against dev AE SQL API.

- [ ] **8. E2E on dev** (spec 12)
  Flows: `F-EVT-1` (slow).
  Satisfies: E2E-3.3
