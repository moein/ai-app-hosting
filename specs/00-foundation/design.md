# 00 — Foundation: Design

## Repository layout

```
.
├── CLAUDE.md
├── package.json                 # root scripts: lint, typecheck, test, deps:check, check:wrangler
├── pnpm-workspace.yaml          # apps/*, packages/*, fixtures/*, e2e
├── biome.json
├── tsconfig.base.json           # strict, ES2022, moduleResolution bundler, types: @cloudflare/workers-types via wrangler types
├── .github/workflows/ci.yml     # PR checks; deploy dev on main; deploy prod on v* tags
├── apps/
│   ├── api/                     # MCP server, build callbacks, SES webhooks, Workflows, queue consumer
│   │   ├── wrangler.jsonc
│   │   ├── migrations/          # generated SQL (drizzle-kit)
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts         # Worker entry: exports default { fetch: app.fetch, queue, scheduled } + DO/Workflow classes
│   │       ├── http/
│   │       │   ├── app.ts       # main Hono app: global middleware + app.route(prefix, group) only
│   │       │   ├── env.ts       # AppEnv = { Bindings: Env; Variables: { requestId, … } }
│   │       │   ├── middleware/  # reusable middleware (requestId, errorHandler, oidcAuth, snsSignature, …)
│   │       │   └── routes/      # one file per route group: health.ts, mcp.ts, builds.ts, contract.ts, ses.ts
│   │       ├── db/schema.ts
│   │       ├── mcp/  workflows/  jobs/  integrations/
│   ├── dispatcher/              # *.APPS_DOMAIN router
│   ├── tail/                    # tail consumer + AppLogBuffer DO
│   ├── email/                   # PlatformMail (Resend) + AppMail (SES)
│   └── e2e-inbox/               # dev-only: receives e2e test emails (spec 12)
├── packages/
│   ├── shared/                  # ids.ts, errors.ts, limits.ts, time.ts, slugs.ts, schemas/
│   └── app-contract/            # guide.md, validator, managed files (deploy.yml, platform.json)
├── fixtures/
│   └── contract-app/            # test-only minimal app satisfying the contract
├── e2e/                         # e2e suite run against deployed dev (spec 12)
└── specs/
```

`integrations/` in `apps/api` wraps each external system behind an interface so tests can inject fakes:
`GitHubClient`, `CloudflareClient` (WfP scripts, assets, secrets, D1 REST), `Clock`, `Random`.

## HTTP routing (Hono route groups)

Every HTTP-serving worker composes its routes from **route groups** (FND-8). A group is one `Hono` instance holding a set of related routes plus the middleware that applies only to them. The main app knows nothing about individual routes: it adds global middleware and mounts each group under its prefix.

```ts
// apps/api/src/http/env.ts
export type AppEnv = { Bindings: Env; Variables: { requestId: string; oidc?: GitHubOidcClaims } };

// apps/api/src/http/routes/builds.ts — paths are relative; the group never knows it lives at /v1/builds
export const buildsRoutes = new Hono<AppEnv>()
  .use('*', oidcAuth())                       // group-specific middleware (spec 08)
  .post('/start', startHandler)
  .post('/:deployment/fail', failHandler)
  .put('/:deployment/artifact', artifactHandler);

// apps/api/src/http/app.ts — global middleware + mounting only, no handlers
export const app = new Hono<AppEnv>()
  .use('*', requestId(), errorHandler())
  .route('/healthz', healthRoutes)
  .route('/mcp', mcpRoutes)                   // delegates to McpSession.serve (spec 04)
  .route('/v1/builds', buildsRoutes)          // OIDC-authenticated (spec 08)
  .route('/v1/contract', contractRoutes)      // public, immutable caching (spec 06)
  .route('/v1/ses', sesRoutes);               // SNS-signature-verified (spec 11)

// apps/api/src/index.ts — env is validated here, before Hono sees the request
export default {
  fetch(request, env, ctx) {
    try {
      parseEnv(env);
    } catch (error) {
      return errorResponse(toPlatformError(error));
    }
    return app.fetch(request, env, ctx);
  },
  queue,
  scheduled,
} satisfies ExportedHandler<Env>;
```

Rules:
- One file per group in `src/http/routes/`, exporting `<group>Routes`. Handlers may live in the same file or in feature modules; the group file is the single place that lists the group's routes.
- Group-only middleware is attached with `.use()` inside the group. Middleware used by several groups lives in `src/http/middleware/` and is still attached per group, not globally.
- Global middleware in `app.ts` is limited to cross-cutting concerns that apply to every request: request ID, error → `PlatformError` JSON mapping, logging.
- Prefixes are declared only in `app.ts`, so moving or versioning a group (`/v1` → `/v2`) is a one-line change.
- Groups are tested in isolation with `group.request(path, init, env)`; `app.ts` has one test asserting every registered route path starts with a mounted prefix (FND-8.3).

`apps/api` groups:

| Group | Prefix | Group middleware | Spec |
|---|---|---|---|
| `healthRoutes` | `/healthz` | — | 00 |
| `mcpRoutes` | `/mcp` | — (auth is per tool, spec 02) | 04 |
| `buildsRoutes` | `/v1/builds` | `oidcAuth()` | 08 |
| `contractRoutes` | `/v1/contract` | `immutableCache()` | 06 |
| `sesRoutes` | `/v1/ses` | `snsSignature()` | 11 |

`apps/dispatcher` routes by hostname, not path, so it's a single `fetch` handler without groups. `apps/tail` and `apps/email` serve no HTTP routes (tail handler, RPC entrypoints, queue consumer); only a `/healthz` group if they ever expose HTTP.

## Logging (FND-9)

`packages/shared/src/logger.ts`:

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMetadata = Record<string, unknown>;

class Logger {
  static get root(): Logger;                           // lazily created on first access, then reused
  constructor(context?: LogMetadata);
  child(context: LogMetadata): Logger;                 // parent context + context
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}
```

Usage:

```ts
Logger.root.info('deployment started', { appId, deploymentId });
const log = Logger.root.child({ worker: 'api', requestId });
log.error('unhandled error', { error });               // Error → { name, message, stack, cause }
```

Each call writes one line: `{"timestamp":"2026-09-26T17:40:00.000Z","level":"info","message":"deployment started","appId":"app_…","deploymentId":"dep_…"}` via the matching `console` method (`console.debug/info/warn/error`), so Workers Logs indexes the fields and keeps the level. Field precedence: metadata over context; `timestamp`, `level`, `message` over both. The sink is the only place allowed to call `console.*` — Biome's `noConsole` rule is an error everywhere else. CLI scripts in `scripts/` write human-readable output with `process.stdout/stderr.write` instead of logging.

Never log secrets, login codes or file contents (CLAUDE.md conventions).

## Environments and resource naming

Two environments only: `dev`, `prod`. Every resource name ends with the environment.

| Resource | dev | prod |
|---|---|---|
| Platform D1 | `platform-db-dev` | `platform-db-prod` |
| KV (app routes) | `app-routes-dev` | `app-routes-prod` |
| R2 (build artifacts) | `artifacts-dev` | `artifacts-prod` |
| R2 (events + logs archive, R2 Data Catalog) | `datalake-dev` | `datalake-prod` |
| Queue (email jobs) | `email-jobs-dev` | `email-jobs-prod` |
| Pipeline (MCP events) | `mcp-events-dev` | `mcp-events-prod` |
| Pipeline (runtime logs) | `app-logs-dev` | `app-logs-prod` |
| Analytics Engine dataset | `platform_metrics_dev` | `platform_metrics_prod` |
| Dispatch namespace | `apps-dev` | `apps-prod` |
| Workers | `api-dev`, `dispatcher-dev`, `tail-dev`, `email-dev`, `e2e-inbox-dev` | `api-prod`, `dispatcher-prod`, `tail-prod`, `email-prod` |
| KV (e2e inbox) | `e2e-inbox-dev` | — |
| GitHub org | `GITHUB_ORG` (dev repos prefixed `dev-`) | `GITHUB_ORG` |
| SES (customer app email) | same AWS account, configuration set `apps-mail-dev` | configuration set `apps-mail-prod` |
| Resend (platform email) | API key `platform-dev` | API key `platform-prod` |

Dev and prod share one GitHub org to keep setup simple; dev repos are named `dev-<slug>` to avoid collisions (see spec 07).

## `wrangler.jsonc` shape

Every worker uses `wrangler.jsonc` (JSON with comments and trailing commas) with top-level shared settings and an `env` block per environment. Bindings are non-inheritable in Wrangler, so they are repeated per env.

```jsonc
// apps/api/wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "api",
  "account_id": "CF_ACCOUNT_ID",              // every wrangler.jsonc pins the account (specs/values.md)
  "main": "src/index.ts",
  "compatibility_date": "2026-08-22",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "env": {
    "dev": {
      "name": "api-dev",
      "workers_dev": true,                      // served at PLATFORM_API_ORIGIN (workers.dev) — see specs/values.md
      "preview_urls": false,
      "vars": { "ENVIRONMENT": "dev", "CF_ACCOUNT_ID": "…", "PLATFORM_API_ORIGIN": "…", "APPS_DOMAIN": "dev.APPS_DOMAIN", "GITHUB_ORG": "GITHUB_ORG" },
      "d1_databases": [{ "binding": "DB", "database_name": "platform-db-dev", "database_id": "…", "migrations_dir": "migrations" }],
      "kv_namespaces": [{ "binding": "APP_ROUTES", "id": "…" }],
      "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "artifacts-dev" }],
      "durable_objects": { "bindings": [
        { "name": "MCP_SESSION", "class_name": "McpSession" },
        { "name": "APP_LOGS", "class_name": "AppLogBuffer", "script_name": "tail-dev" }
      ] },
      "workflows": [
        { "binding": "PROVISION_APP", "name": "provision-app-dev", "class_name": "ProvisionApp" },
        { "binding": "DEPLOY_APP", "name": "deploy-app-dev", "class_name": "DeployApp" }
      ],
      "queues": { "producers": [{ "binding": "EMAIL_JOBS", "queue": "email-jobs-dev" }] },
      "ratelimits": [{ "name": "TOOL_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }],
      "pipelines": [{ "binding": "EVENTS", "pipeline": "mcp-events-dev" }],
      "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "platform_metrics_dev" }],
      "services": [{ "binding": "MAIL", "service": "email-dev", "entrypoint": "PlatformMail" }],
      "triggers": { "crons": ["*/5 * * * *", "0 * * * *", "0 3 * * *"] }
    },
    "prod": { "…": "same shape with -prod names" }
  }
}
```

Crons (api): every 5 min — stale deployment sweeper (spec 08); hourly — KV route reconciliation (spec 09); daily 03:00 UTC — login-code purge (spec 02), artifact retention (spec 08).

Other workers: `dispatcher` (KV `APP_ROUTES`, dispatch namespace `DISPATCHER` — spec 09); `tail` (`AppLogBuffer` DO, pipeline `LOG_ARCHIVE` → `app-logs-<env>` — spec 10); `email` (`DB`, `METRICS`, queue consumer `email-jobs-<env>` — spec 11).

Hosts: the platform has no custom domain for now. `api-<env>` is served on its Cloudflare-generated `workers.dev` URL (`PLATFORM_API_ORIGIN`: `https://api-dev.<account>.workers.dev` / `https://api-prod.<account>.workers.dev`); `dispatcher`, `tail` and `email` set `workers_dev: false` (reachable only via route / bindings). User apps live on `*.dev.APPS_DOMAIN` (dev) and `*.APPS_DOMAIN` (prod). Concrete values: `specs/values.md`. Moving the API to a custom domain later only changes `PLATFORM_API_ORIGIN` (plus the managed workflow's `API` value, spec 08).

## Env validation

Each worker validates `env` with a Zod schema (`createEnvParser`, memoized per env object) in its entry point `src/index.ts`, **before** the request reaches Hono or any other handler. Missing/invalid → the entry point responds with `PlatformError(INTERNAL)` JSON (500) without calling the app; the log line names the variables only (FND-2.5). Route groups, middleware and handlers never parse `env` themselves — they read the already validated `c.env`.

Secrets (per env, via `wrangler secret put`):

| Worker | Secrets |
|---|---|
| api | `CF_API_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `LOGIN_CODE_PEPPER` |
| email | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESEND_API_KEY` (vars: `AWS_REGION`, `SES_CONFIGURATION_SET`, `APPS_MAIL_DOMAIN`, `PLATFORM_MAIL_DOMAIN`) |
| e2e-inbox (dev only) | `E2E_INBOX_TOKEN` |
| api (vars) | `SES_EVENTS_TOPIC_ARN`, `APPS_DOMAIN`, `GITHUB_ORG`, `ENVIRONMENT`, `PLATFORM_API_ORIGIN`, `E2E_INBOX_DOMAIN` (dev only) |

## `packages/shared`

| Module | Contents |
|---|---|
| `ids.ts` | `type IdPrefix = 'usr'\|'org'\|'app'\|'dep'\|'evt'\|'lc'`; `newId(prefix)`; `isId(value, prefix)`; branded types `UserId`, `OrgId`, … |
| `errors.ts` | `ErrorCode` union, `PlatformError` class, `ERROR_CATALOG` (default message, hint, retryable per code), `toPlatformError(unknown)` |
| `limits.ts` | All numeric limits/quotas, e.g. `LOGIN_CODE_TTL_MS`, `MAX_APPS_PER_ORG`, `MAX_FILE_BYTES` |
| `time.ts` | `now()` via injectable `Clock`, duration parsing (`"15m"`, `"2h"`) |
| `slugs.ts` | spec 01 |
| `schemas/` | Zod schemas shared by MCP tools and HTTP endpoints |

### ID generation

```ts
import { nanoid } from 'nanoid';
export const newId = <P extends IdPrefix>(p: P) => `${p}_${nanoid(11)}` as Id<P>;
```

nanoid default alphabet `A-Za-z0-9_-`; 11 chars ≈ 66 bits of entropy — ample for our scale. IDs are case-sensitive; never lowercase them. Anything that must be lowercase (Worker script names, repo names, D1 names) uses the **slug**, not the ID.

### Error catalog (initial; features append their codes here)

| Code | retryable | Default hint |
|---|---|---|
| `INTERNAL` | true | Something went wrong on our side. Try again; if it keeps failing, tell the user. |
| `INVALID_INPUT` | false | Fix the fields listed in `details.issues` and call again. |
| `AUTH_REQUIRED` | false | Ask the user for their email address, then call `request_login_code`. |
| `RATE_LIMITED` | true | Wait `details.retry_after_seconds` seconds before retrying. |
| `NOT_FOUND` | false | Check the identifier; use the matching `list_*` tool to find valid values. |
| `QUOTA_EXCEEDED` | false | Tell the user which limit was reached (`details.limit`). |
| `CONFLICT` | true | State changed underneath you; re-read and retry. |
| `UPSTREAM_ERROR` | true | A provider (GitHub/Cloudflare/AWS) failed. Retry shortly. |

Feature specs add: `CODE_INVALID`, `CODE_EXPIRED`, `CODE_ATTEMPTS_EXCEEDED` (02); `APP_NOT_READY`, `APP_DELETED`, `NAME_INVALID` (03); `PROTECTED_PATH`, `FILE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `COMMIT_CONFLICT` (07); `CONTRACT_VIOLATION` (06); `BUILD_FAILED`, `MIGRATION_FAILED`, `DEPLOYMENT_NOT_ROLLBACKABLE` (08); `SECRET_NAME_INVALID`, `QUERY_FAILED` (09); `SLUG_INVALID`, `SLUG_UNAVAILABLE` (01); `EMAIL_UNDELIVERABLE`, `ACCOUNT_BLOCKED` (02); `DEPLOY_FAILED` (08). Spec 11 adds no MCP-level codes (app email errors are returned in `AppMail` results).

## Platform D1 schema (index)

Tables are specified in the owning feature's design.md:

| Table | Spec |
|---|---|
| `users`, `login_codes` | 02 |
| `organizations`, `memberships`, `apps`, `usage_counters` | 03 |
| `deployments` | 08 |
| `app_secrets` | 09 |
| `email_suppressions` | 11 |

Conventions: `TEXT` primary keys holding prefixed IDs; `created_at`/`updated_at` `INTEGER` epoch ms; foreign keys declared (`PRAGMA foreign_keys` is on in D1); soft-delete via `deleted_at` only where a spec asks for it.

## Testing setup

- `vitest.config.ts` per workspace.
  - `packages/*`: plain Vitest (Node).
  - `apps/*`: `@cloudflare/vitest-pool-workers` using the worker's `wrangler.jsonc` (`env: "dev"`), with `readD1Migrations()` + `applyD1Migrations()` in a setup file (FND-6.2). Isolated storage per test file.
- External systems are faked via the `integrations/` interfaces; no test hits GitHub, Cloudflare API or AWS.
- End-to-end tests run against the deployed dev environment (spec 12). There is no local dev environment (`wrangler dev` is not used).

## Dependency policy

- Exact pins (`save-exact=true` in `.npmrc`).
- `pnpm deps:check` = `pnpm outdated -r --format json` wrapped by a script that fails if anything is behind latest stable (FND-5.3). Run weekly in CI (non-blocking) and before releases.

## CI and deploys

CI (`.github/workflows/ci.yml`, GitHub Actions) only checks — it has no secrets and never deploys:

```
on: pull_request, push main → pnpm install --frozen-lockfile → check:wrangler → lint → typecheck → test
```

Deploys run from the operator's terminal with the locally authenticated `wrangler` (`scripts/deploy.mjs`):

```
pnpm deploy:dev   → checks → d1 migrations apply platform-db-dev --remote → deploy dev workers → pnpm e2e
pnpm deploy:prod  → require clean tree on pushed main → checks → d1 migrations apply platform-db-prod --remote → deploy prod workers
```

Deploy order: `email` → `tail` → `api` → `dispatcher` (service-binding targets first), then dev-only `e2e-inbox`. Workers or steps that don't exist yet (e.g. no D1 before task 7, no `e2e/` before spec 12) are skipped. Worker secrets are set once per environment from the operator's git-ignored root `.env` with `wrangler secret put` (runbook).

`check:wrangler` = a script failing if `git ls-files` contains `wrangler.toml` or `wrangler.json` (FND-2.2).

## One-time manual setup per environment (documented runbook, `docs/runbook.md` later)

1. Create Cloudflare resources from the naming table; put their IDs into `wrangler.jsonc`.
2. Create the GitHub App (spec 07), install it on `GITHUB_ORG`.
3. Email: SES — verify `APPS_MAIL_DOMAIN`, configuration set, SNS topic → `/v1/ses/events` (spec 11). Resend — verify `PLATFORM_MAIL_DOMAIN`, API key (spec 11). Dev only — Email Routing catch-all on `E2E_INBOX_DOMAIN` → `e2e-inbox-dev` (spec 12).
4. DNS: add `APPS_DOMAIN` as a Cloudflare zone; wildcard `*.APPS_DOMAIN` route to dispatcher (spec 09); SES DNS records (DKIM, MAIL FROM, DMARC) for `APPS_MAIL_DOMAIN`; Resend DNS records for `PLATFORM_MAIL_DOMAIN`. The API needs no DNS (workers.dev).

## Open questions

1. Should dev use a separate GitHub org instead of `dev-` repo prefixes? (Cleaner isolation, one more GitHub App install.)
2. Separate AWS account for dev SES? (SES sandbox limits in dev may be acceptable.)
3. `compatibility_date` bump cadence for platform workers.
