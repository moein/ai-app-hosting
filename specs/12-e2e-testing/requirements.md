# 12 — End-to-End Testing: Requirements

Every user-facing flow has an end-to-end test that runs against the **deployed dev environment**, driving the platform exactly like a real AI client (MCP over Streamable HTTP) and observing real side effects: emails actually delivered, apps actually built and served on `APPS_DOMAIN`. There is no local environment: platform workers are never run locally for development; dev on Cloudflare is where flows are exercised.

Implemented right after spec 00; every later feature adds its flows here.

## Stories & acceptance criteria

### E2E-1 — Harness
As a platform developer, I want one command that exercises every flow on dev, so that I know the deployed system works end to end.

- **E2E-1.1** THE SYSTEM SHALL provide an `e2e/` workspace whose Vitest suite targets the deployed dev environment only, configured solely through environment variables (`E2E_API_ORIGIN`, `E2E_APPS_DOMAIN`, `E2E_INBOX_ORIGIN`, `E2E_INBOX_TOKEN`, `E2E_INBOX_ADDRESS`; plus `RESEND_API_KEY` and `E2E_PROBE_FROM` for the inbox self-test), read from the environment or the git-ignored `.env.dev`, with no local workers, emulators or `.dev.vars`.
- **E2E-1.2** WHEN the suite starts IF `GET <E2E_API_ORIGIN>/healthz` does not report `environment: "dev"` THEN THE SYSTEM SHALL abort without running any test.
- **E2E-1.3** THE SYSTEM SHALL drive the platform through the official MCP TypeScript SDK `Client` with the Streamable HTTP transport against `<E2E_API_ORIGIN>/mcp` — the same path a real AI client uses — with no test-only backdoors in the platform.
- **E2E-1.4** THE SYSTEM SHALL give every run a unique `runId` and derive all identities from it (emails `<local>+<runId>-<n>@<domain>` derived from `E2E_INBOX_ADDRESS` = `<local>@<domain>`, app names `e2e <runId> <n>`), so runs never collide and can execute concurrently.
- **E2E-1.5** WHEN `pnpm e2e` is run THE SYSTEM SHALL run the whole suite; `pnpm e2e <pattern>` SHALL run a subset; tests tagged `slow` SHALL run only with `E2E_INCLUDE_SLOW=1`.
- **E2E-1.6** WHEN `pnpm deploy:dev` has deployed the workers (FND-7.2) THE SYSTEM SHALL run the e2e suite and exit non-zero if any test fails.

### E2E-2 — Real email inbox for tests
As a test, I want to read emails the platform really sent, so that login and app email flows are verified end to end.

- **E2E-2.1** THE SYSTEM SHALL route email for `E2E_INBOX_ADDRESS` and all its subaddresses (`<local>+<tag>@<domain>`; one Cloudflare Email Routing rule with subaddressing enabled on the zone) to a dev-only `e2e-inbox` Worker that parses each message and stores `{ id, to, from, subject, text, html, received_at }` in KV with a 24-hour TTL, keyed by the full recipient address including the `+tag`.
- **E2E-2.2** WHEN `GET <E2E_INBOX_ORIGIN>/messages?to=<address>&since=<epoch_ms>` is called with `Authorization: Bearer <E2E_INBOX_TOKEN>` THE SYSTEM SHALL return matching messages newest first; without a valid token it SHALL respond 401.
- **E2E-2.3** THE SYSTEM SHALL provide a harness helper `waitForEmail({ to, since, timeoutMs, match? })` that polls the inbox until a matching message arrives or the timeout elapses (default 60 s).
- **E2E-2.4** THE SYSTEM SHALL deploy `e2e-inbox` to dev only; its `wrangler.jsonc` SHALL define only the `dev` environment (the one exception to FND-2.1).
- **E2E-2.5** THE SYSTEM SHALL include an inbox self-test (`F-E2E-1`) that sends a probe through Resend from `E2E_PROBE_FROM` to a fresh subaddress and waits for it in the inbox, so a broken routing rule fails fast instead of surfacing as auth failures.

### E2E-3 — Coverage rule
As the product owner, I want no flow to ship untested, so that dev always reflects working software.

- **E2E-3.1** THE SYSTEM SHALL keep the flow catalog in design.md listing every user-facing flow with a stable ID (`F-<AREA>-<n>`).
- **E2E-3.2** THE SYSTEM SHALL tag each e2e test with the flow IDs it covers, and a coverage test SHALL fail if any catalog flow whose feature is implemented has no tagged test.
- **E2E-3.3** THE SYSTEM SHALL end every feature's `tasks.md` with an **E2E** task listing that feature's flow IDs; a feature is complete only when its E2E task passes on dev.

### E2E-4 — Test data hygiene
As the operator, I want e2e runs to leave nothing behind, so that dev stays clean and cheap.

- **E2E-4.1** THE SYSTEM SHALL have each test file delete the apps it created (`delete_app`) in `afterAll`, even when tests fail.
- **E2E-4.2** WHEN the api worker's hourly cron runs in `dev` THE SYSTEM SHALL hard-purge every user whose email is a subaddress of `E2E_INBOX_ADDRESS` (`<local>+%@<domain>`) and was created more than `E2E_PURGE_AFTER_MS` (1 hour) ago, including their orgs, apps, GitHub repos, D1 databases, their R2 storage buckets (spec 15), Worker scripts, KV routes, R2 build artifacts, log buffers, SES identities with their DKIM records, and SES tenants.
- **E2E-4.3** THE SYSTEM SHALL never run the purge in `prod` (guarded by `ENVIRONMENT === "dev"` and by `E2E_INBOX_ADDRESS` being unset in prod).

## Non-functional requirements

- Full suite (excluding `slow`) completes in < 15 minutes; flows run in parallel files.
- Tests are resilient to eventual consistency: they poll with explicit timeouts rather than sleeping fixed durations.
- The harness needs only: Node LTS, `pnpm install`, and the `E2E_*` environment variables (read from the operator's git-ignored `.env.dev`).

## Out of scope

- Running platform workers locally (`wrangler dev`) — not supported.
- Load/performance testing.
- E2E against prod (smoke checks on prod may come later as a separate, read-only suite).
