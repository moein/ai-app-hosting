# 12 — End-to-End Testing: Tasks

Depends on: 00 (deployed dev workers). Implemented right after spec 00; flows are added as features land (each feature's E2E task).

- [x] **1. `e2e/` workspace skeleton**
  Env parsing, runId/factories, MCP client wrapper, `flow()` tagging, global setup with healthz guard.
  Satisfies: E2E-1.1, E2E-1.2, E2E-1.3, E2E-1.4, E2E-1.5
  Tests: suite aborts when `/healthz` reports another environment (pointed at a stub URL); `F-FND-1` passes on dev.

- [x] **2. `e2e-inbox` worker + Email Routing (dev)**
  Worker (email handler + `/messages` route group with bearer auth), KV, secret; harness `waitForEmail`. Email Routing rule for `E2E_INBOX_ADDRESS` + subaddressing is set up by the operator in the dashboard after the first deploy (the wrangler token has no `email_routing:write`).
  Satisfies: E2E-2.1, E2E-2.2, E2E-2.3, E2E-2.4, E2E-2.5
  Tests: unit — parse + store + list/filter + 401 without token; e2e — send a message to `<local>+probe@<domain>` from any mailbox and see it via `waitForEmail` (manual once), then covered by `F-AUTH-1`.

- [x] **3. Flow catalog + coverage check**
  Satisfies: E2E-3.1, E2E-3.2, E2E-3.3
  Tests: coverage test fails when an implemented flow lacks a tagged test (verified by temporarily flipping a flag).

- [x] **4. Run e2e from `pnpm deploy:dev`**
  `scripts/deploy.mjs` runs `pnpm e2e` after deploying dev.
  Satisfies: E2E-1.6
  Tests: `pnpm deploy:dev` exits non-zero on a failing e2e test (verified once).

- [ ] **5. Cleanup: `afterAll` deletes + dev purge cron** (after specs 03, 07, 08 exist)
  Satisfies: E2E-4.1, E2E-4.2, E2E-4.3
  Tests: integration — purge removes only e2e users older than `E2E_PURGE_AFTER_MS` and calls every integration fake; keeps rows when an external deletion fails; no-op when `ENVIRONMENT=prod`; e2e — create app, backdate user in dev D1 via a dev-only migration-free SQL script, run purge, verify repo/D1/script gone.
  Status: `afterAll` deletes and the purge job with its integration tests are done; the e2e check runs once the api (with the purge cron) can be deployed — blocked on R2.
