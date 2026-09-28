# 08 — Build & Deploy: Tasks

Depends on: 03, 06, 07, 09 (tasks 1–2: `CloudflareClient`, bindings builder).

- [x] **1. Schema: `deployments`** + state-transition helpers (conditional updates) + public status mapping.
  Satisfies: DEP-3.1 (status mapping), DEP-2.5
  Tests: every allowed transition succeeds; disallowed transitions change 0 rows; `succeeded` maps to `live`/`superseded`.

- [x] **2. Managed `deploy.yml`**
  Satisfies: DEP-1.1, DEP-1.2, DEP-1.3, DEP-1.4, DEP-1.5, DEP-1.6, DEP-1.7, CON-4.5
  Tests: `actionlint` passes; YAML assertions (triggers, concurrency, permissions, timeout, step order, pinned action SHAs, no `secrets.` references); run it for real against `fixtures/contract-app` in a dev test repo (task 9).
  Status: actionlint (+ shellcheck) runs in the app-contract tests and CI; real runs on dev build, validate and report failures (F-DEP-2, F-DEP-3 pass; F-DEP-1 reaches `deploying`).

- [x] **3. OIDC verifier**
  Satisfies: DEP-2.1
  Tests: tokens signed by a test JWKS: valid passes; each claim mismatch (iss, aud, exp, repository_id, ref, workflow_ref, event_name) → 401; unknown `kid` triggers one JWKS refetch.

- [x] **4. Callback endpoints: start, fail, artifact**
  Satisfies: DEP-2.2, DEP-2.3, DEP-2.4, DEP-2.5, CON-4.5
  Tests (pool-workers, R2): start moves queued→building and cancels siblings; start without deployment creates one and consumes quota (429 when exhausted); fail stores violations vs log tail with correct code; artifact stored at expected key and workflow started; oversize artifact rejected; callbacks for cancelled/deleted → 409.

- [x] **5. Artifact reader** (gunzip + tar + structure checks)
  Satisfies: DEP-2.6, CON-2.7
  Tests: fixture artifact from `fixtures/contract-app` build parses; missing `dist/app/wrangler.json` / main module / `dist/client` → `BUILD_FAILED`; main module without a default export → `BUILD_FAILED` naming CON-2.7.

- [x] **6. Migrations runner** (D1 REST via `CloudflareClient`)
  Satisfies: DEP-2.7, DEP-2.8
  Tests (fake D1 REST backed by a real local D1): applies new files in order; skips applied; changed hash → `MIGRATION_FAILED` naming file; SQL error → `MIGRATION_FAILED`; nothing else runs after failure.

- [x] **7. `DeployApp` workflow**
  Satisfies: DEP-2.9, DEP-2.10, DEP-2.11, DEP-2.13, DEP-4.2 (skip migrations path)
  Tests (fake Cloudflare): upload metadata has exactly the platform bindings + `keep_bindings` + tail consumer + tags; app-declared extra bindings ignored; success sets live + KV route; upload failure after retries → `DEPLOY_FAILED` with previous live unchanged. (The `deployment_finished` metric is asserted in spec 05 task 6.)

- [x] **8. Tools: `get_deployment` (with wait), `list_deployments`, `redeploy`, `rollback`**
  Satisfies: DEP-3.1, DEP-3.2, DEP-3.3, DEP-4.1, DEP-4.2, DEP-4.3, DEP-4.4
  Tests: default latest; wait returns early on change and at timeout (fake clock); pagination cursor; redeploy dispatches workflow with deployment id and consumes quota; rollback only from `superseded` with artifact; rollback result warning text.

- [x] **9. Crons: stale sweeper + artifact retention**
  Satisfies: DEP-2.12, DEP non-functional (retention)
  Tests: queued >15 min and building >20 min fail with message; retention keeps 20 newest succeeded + live.

- [x] **10. E2E on dev** (spec 12)
  Flows: `F-DEP-1`, `F-DEP-2`, `F-DEP-3`, `F-DEP-4`, `F-DEP-5`. Record push-to-live timing from `F-DEP-1`.
  Timing (2026-09-28, dev): write_files → live and serving `/api/health` ≈ 57 s (GitHub Actions build included).
  Satisfies: E2E-3.3, DEP non-functional (push-to-live timing)
