# 12 — End-to-End Testing: Design

## Topology

```
developer machine / CI runner
  pnpm e2e  (e2e/ workspace, Vitest)
    ├─ MCP SDK Client ──Streamable HTTP──▶ PLATFORM_API_ORIGIN (dev)/mcp
    ├─ fetch ─────────────────────────────▶ https://<slug>.APPS_DOMAIN (dev)       (apps built by the platform)
    └─ fetch (Bearer E2E_INBOX_TOKEN) ────▶ e2e-inbox-dev /messages
                                                ▲
            Resend (login codes) ──▶ MX of APPS_DOMAIN apex ──▶ Cloudflare Email Routing (rule: E2E_INBOX_ADDRESS + subaddresses) ──▶ e2e-inbox-dev (email handler) ──▶ KV
            SES (app emails)     ──┘
```

No platform code path is test-specific: login codes arrive through real email, apps are built by real GitHub Actions and served by the real dispatcher.

## `e2e/` workspace

```
e2e/
├── package.json            # "e2e": "vitest run --config vitest.config.ts"
├── vitest.config.ts        # globalSetup: env check + healthz guard (E2E-1.2); testTimeout 10 min; fileParallelism true
├── src/
│   ├── env.ts              # Zod-parsed E2E_* env vars (environment first, then .env.dev)
│   ├── global-setup.ts     # healthz guard (E2E-1.2)
│   ├── run.ts              # runId (nanoid), email/app name factories
│   ├── mcp.ts              # connect(): MCP Client + StreamableHTTPClientTransport; callTool() → typed result | PlatformError
│   ├── inbox.ts            # waitForEmail(), extractLoginCode()
│   ├── auth.ts             # signUp()/signIn(): request_login_code → waitForEmail → verify_login_code
│   ├── apps.ts             # createApp(), deleteApp(), writeFixture(), waitForDeployment(), appUrl()
│   └── flows.ts            # flow(id, …) tagging helper → test name prefix "[F-XXX-n]"
├── fixtures/               # small file sets written via write_files (contract violation, type error, …)
└── tests/                  # one file per feature: auth.e2e.ts, apps.e2e.ts, deploy.e2e.ts, …
```

The deploy-related tests write `fixtures/contract-app` (repo root, spec 06) through `write_files`. It exposes test endpoints used by flows below:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | 200 + a D1 query result (DB binding works) |
| `GET /api/secret-hash?name=X` | SHA-256 of `env[X]` (never the value) |
| `POST /api/log` | `console.log`/`console.error` a given marker, optionally `throw` |
| `POST /api/send-email` | `env.EMAIL.send()` to a given address; returns the result |

## `e2e-inbox` worker (`apps/e2e-inbox`, dev only)

```jsonc
// apps/e2e-inbox/wrangler.jsonc
{
  "name": "e2e-inbox",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-22",
  "env": {
    "dev": {
      "name": "e2e-inbox-dev",
      "workers_dev": true,
      "kv_namespaces": [{ "binding": "INBOX", "id": "…" }]
      // secret: E2E_INBOX_TOKEN
    }
    // intentionally no "prod" (E2E-2.4)
  }
}
```

- `email(message)` handler: parse with `postal-mime`; key `msg:<to>:<received_at>:<id>`; TTL 86,400 s.
- HTTP: single route group `messagesRoutes` at `/messages` with `bearerAuth(E2E_INBOX_TOKEN)` inside the group (FND-8); `GET /` lists by prefix `msg:<to>:` filtered by `since`.
- Email Routing (dashboard, `APPS_DOMAIN` zone): enable Email Routing on the apex, enable **Subaddressing** in its settings, and add one custom-address rule `E2E_INBOX_ADDRESS` → *Send to a Worker* → `e2e-inbox-dev`. The Worker only appears in that dropdown once it's deployed with an `email()` handler.

## Flow catalog (E2E-3.1)

| ID | Flow | Spec |
|---|---|---|
| `F-E2E-1` | Inbox self-test: a probe sent via Resend to a fresh `E2E_INBOX_ADDRESS` subaddress arrives in the e2e inbox | 12 |
| `F-FND-1` | `GET /healthz` on the dev API reports `status: "ok"`, `environment: "dev"` | 00 |
| `F-MCP-1` | `initialize` (no auth header) returns a session and instructions; every tool in `tools/list` is in the spec 04 catalog with its public flag reflected in behavior and its annotations; once every feature is implemented, `tools/list` equals the catalog | 04 |
| `F-MCP-2` | `get_platform_guide` returns every topic without login | 04 |
| `F-MCP-3` | Invalid tool input → `INVALID_INPUT` with issue paths | 04 |
| `F-AUTH-1` | Sign up: request code → real email → verify → `is_new_user: true`, `whoami` authenticated | 02, 11 |
| `F-AUTH-2` | Sign in again from a new MCP session → `is_new_user: false` | 02 |
| `F-AUTH-3` | Wrong code → `CODE_INVALID` with `attempts_remaining`; 5 wrong → `CODE_ATTEMPTS_EXCEEDED` | 02 |
| `F-AUTH-4` | Protected tool without login → `AUTH_REQUIRED`; `logout` → `AUTH_REQUIRED` again | 02 |
| `F-AUTH-5` | Per-session login-code limit → `RATE_LIMITED` | 02 |
| `F-SLUG-1` | `check_slug`: available / taken (with suggestion) / reserved / invalid | 01 |
| `F-APP-1` | `create_app` → `ready`; `list_apps`/`get_app` show it; URL serves the 503 "being built" page | 03, 09 |
| `F-APP-2` | `create_app` with a taken slug → `SLUG_UNAVAILABLE` + suggestion | 01, 03 |
| `F-APP-3` | `delete_app` → URL 404; `get_app` `status: deleted`; slug still taken | 03 |
| `F-APP-4` | `get_usage` reflects created apps and deploys | 03 |
| `F-SRC-1` | `write_files` (`deploy: false`) → `list_files`/`read_file` return content; managed path → `PROTECTED_PATH` | 07 |
| `F-SRC-2` | `write_files` with stale `base_commit_sha` → `COMMIT_CONFLICT` | 07 |
| `F-DEP-1` | Write contract app → deployment `live` → `/api/health` 200 with DB result | 06, 08, 09 |
| `F-DEP-2` | Contract violation → `failed` with `CONTRACT_VIOLATION` + violations | 06, 08 |
| `F-DEP-3` | Type error → `BUILD_FAILED` with parsed TypeScript error (file, line) | 08, 10 |
| `F-DEP-4` | `redeploy` → new live deployment; `rollback` to a superseded one → served again | 08 |
| `F-DEP-5` | New migration applied; editing an applied migration → `MIGRATION_FAILED`, previous stays live | 08 |
| `F-RUN-1` | `set_secret` → `/api/secret-hash` matches; `list_secrets` has no values; `delete_secret` removes it | 09 |
| `F-RUN-2` | `query_database` read works; write rejected without `allow_writes`, succeeds with it | 09 |
| `F-RUN-3` | Unknown slug → 404 page; `www.` → redirect to `PLATFORM_WEBSITE_URL` | 09 |
| `F-RUN-4` | App cookies come back host-only as `__Host-…`; only those reach the app (prefix stripped); same-site requests arrive without cookies | 09 |
| `F-LOG-1` | Request to `/api/log` (log + throw) → `get_logs` returns request, console and exception entries | 10 |
| `F-MAIL-1` | App sends email via `env.EMAIL` → arrives in e2e inbox from `hello@mail.<slug>.APPS_DOMAIN` | 11 |
| `F-WEB-1` | Homepage on the apex serves the app with security headers; `/api/config` has the MCP URL; `www.` redirects to it | 14 |
| `F-EVT-1` (slow) | A tool call's event appears in the R2 `mcp_events` table and a `tool_call` data point in Analytics Engine | 05 |
| `F-USG-1` (slow) | Traffic, a D1 query and an email of a deployed app show up in its `app_usage_daily` rows after collection | 13 |

`F-EVT-1` and `F-USG-1` need `E2E_CF_API_TOKEN` (read-only: Account Analytics, D1, R2 Data Catalog; falls back to `CF_API_TOKEN` from `.env.dev`) and run only with `E2E_INCLUDE_SLOW=1`.

## Coverage check (E2E-3.2)

`tests/coverage.e2e.ts` imports the catalog (`src/catalog.ts`, mirrors the table above with an `implemented` flag per flow) and the registered test names; fails if an implemented flow has no test whose name starts with `[<flow id>]`.

## Purge (E2E-4.2)

Dev-only branch of the api worker's hourly cron (`src/jobs/purge-e2e.ts`): select users `WHERE email LIKE '<local>+%@<domain>' AND created_at < now - E2E_PURGE_AFTER_MS` (built from `E2E_INBOX_ADDRESS`, `_`/`%` escaped); for each of their orgs' apps (any status): delete Worker script, KV route, D1 database, GitHub repo, R2 artifacts (`artifacts/<appId>/`), log buffer (`AppLogBuffer.purge()`); then enqueue `{ type: 'org.purge_email', orgId, domains }` so the email worker deletes each app's SES identity with its DKIM CNAMEs and the org's tenant; then delete rows (deployments, app_secrets, apps, usage_counters, org suppressions, memberships, organizations, login_codes, users). If any external deletion for a user fails, that user's rows are kept so the next run retries (every deletion is idempotent: not-found counts as done).

Hourly with a 1-hour age (rather than daily/24 h) keeps dev inside the `APPS_DOMAIN` zone's DNS record quota — every e2e app adds 3 DKIM records — while never touching a running suite (< 15 minutes). `E2E_INBOX_ADDRESS` is a var set only in `env.dev`.

## Running

`pnpm deploy:dev` runs `pnpm e2e` after deploying (FND-7.2); `pnpm e2e` can also be run on its own. `E2E_*` variables come from the git-ignored `.env.dev`.

## Open questions

1. Run the `slow` suite nightly instead of per deploy?
2. Should failed e2e on dev block tagging a prod release automatically?
