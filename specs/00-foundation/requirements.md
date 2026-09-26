# 00 — Foundation: Requirements

The groundwork every other feature builds on: workspace, environments, configuration, IDs, errors, database migrations, dependency policy and CI/CD.

## Stories & acceptance criteria

### FND-1 — Workspace and tooling
As a platform developer, I want a single monorepo with consistent tooling, so that every worker and package is built, linted and tested the same way.

- **FND-1.1** THE SYSTEM SHALL be a pnpm workspace containing `apps/*`, `packages/*`, `fixtures/*` and `e2e`.
- **FND-1.2** WHEN `pnpm lint` is run at the root THE SYSTEM SHALL run Biome over all workspaces and exit non-zero on any violation.
- **FND-1.3** WHEN `pnpm typecheck` is run at the root THE SYSTEM SHALL type-check every workspace with TypeScript `strict: true` and exit non-zero on any error.
- **FND-1.4** WHEN `pnpm test` is run at the root THE SYSTEM SHALL run every workspace's Vitest suite and exit non-zero on any failure.

### FND-2 — Environments and configuration
As a platform operator, I want exactly two isolated environments, so that changes are verified in dev before reaching users in prod.

- **FND-2.1** THE SYSTEM SHALL define exactly two environments, `dev` and `prod`, in every worker's configuration, and no others.
- **FND-2.2** THE SYSTEM SHALL configure every worker with a `wrangler.jsonc` file; WHEN CI runs IF any `wrangler.toml` or `wrangler.json` exists in the repo THEN CI SHALL fail.
- **FND-2.3** THE SYSTEM SHALL give each environment its own Cloudflare resources (D1, KV, R2, Queues, Pipelines, Analytics Engine dataset, dispatch namespace), named with the `-dev` / `-prod` suffix convention in design.md.
- **FND-2.4** THE SYSTEM SHALL NOT contain secret values in the repository; secrets SHALL be provided only via `wrangler secret put --env <env>` to deployed environments (there is no local environment and no `.dev.vars`).
- **FND-2.5** WHEN a worker starts handling a request IF a required env var or secret is missing or malformed THEN THE SYSTEM SHALL fail with error code `INTERNAL` and log which variable is invalid (never its value).

### FND-3 — Identifiers
As a developer, I want one ID format everywhere, so that IDs are short, URL-safe and self-describing.

- **FND-3.1** THE SYSTEM SHALL generate every entity ID as `<prefix>_<nanoid(11)>` using nanoid's default URL-safe alphabet, matching `^(usr|org|app|dep|evt|lc)_[A-Za-z0-9_-]{11}$`.
- **FND-3.2** THE SYSTEM SHALL generate IDs only through `newId(prefix)` in `packages/shared`.
- **FND-3.3** WHEN `isId(value, prefix)` is called THE SYSTEM SHALL return true only for strings matching FND-3.1 with that prefix.

### FND-4 — Error contract
As an AI client, I want every failure to be typed and actionable, so that I can recover without human help.

- **FND-4.1** THE SYSTEM SHALL represent every failure as `PlatformError { code, message, hint, retryable, details? }`, where `code` is one of the codes enumerated in `packages/shared/errors.ts`.
- **FND-4.2** WHEN an unexpected exception is thrown THE SYSTEM SHALL convert it to code `INTERNAL` with a generic message and hint, and SHALL NOT expose stack traces or internal identifiers to the caller.
- **FND-4.3** THE SYSTEM SHALL provide a non-empty `hint` for every error code.

### FND-5 — Dependency policy
As a platform developer, I want current, pinned dependencies, so that builds are reproducible and we benefit from the latest fixes.

- **FND-5.1** THE SYSTEM SHALL pin every dependency to an exact version (no `^` or `~`).
- **FND-5.2** THE SYSTEM SHALL use at least the baseline versions listed in `/CLAUDE.md` (including react 19.3.0 in fixtures and hono 4.13.9).
- **FND-5.3** WHEN `pnpm deps:check` is run THE SYSTEM SHALL list every dependency whose pinned version is behind the latest stable version on npm.

### FND-6 — Platform database
As a platform developer, I want versioned schema migrations, so that dev and prod databases evolve safely.

- **FND-6.1** THE SYSTEM SHALL define the platform D1 schema with Drizzle in `apps/api/src/db/schema.ts` and commit generated SQL migrations to `apps/api/migrations/`.
- **FND-6.2** WHEN integration tests run THE SYSTEM SHALL apply all migrations to an isolated D1 instance before tests execute.
- **FND-6.3** THE SYSTEM SHALL store all timestamps as UTC epoch milliseconds in `INTEGER` columns.

### FND-7 — Checks in CI, deploys from the terminal
As a platform operator, I want every change checked automatically and deploys run from my authenticated terminal, so that no Cloudflare credentials live in CI and only verified code reaches each environment.

- **FND-7.1** WHEN a pull request is opened or updated, or a commit lands on `main`, THE SYSTEM SHALL run the `check:wrangler` check (FND-2.2), lint, typecheck and test in GitHub Actions. CI SHALL hold no Cloudflare, AWS or Resend credentials and SHALL NOT deploy.
- **FND-7.2** WHEN `pnpm deploy:dev` is run from a terminal with an authenticated `wrangler` THE SYSTEM SHALL run the checks, apply platform D1 migrations to dev, deploy every worker to `dev` in dependency order, and then run the e2e suite against dev (E2E-1.6), exiting non-zero if any step fails.
- **FND-7.3** WHEN `pnpm deploy:prod` is run THE SYSTEM SHALL refuse unless the working tree is clean and `HEAD` is on `main` and pushed to `origin`; then run the checks, apply platform D1 migrations to prod and deploy every worker to `prod`.
- **FND-7.4** IF checks or migrations fail THEN THE SYSTEM SHALL NOT deploy workers for that environment.

### FND-8 — HTTP route groups
As a platform developer, I want HTTP routes organized in self-contained groups, so that each group carries its own middleware (auth, signature checks) and can be tested and moved independently.

- **FND-8.1** THE SYSTEM SHALL define each group of related HTTP routes as a separate `Hono` instance exported from `src/http/routes/<group>.ts`, declaring paths relative to the group (the group SHALL NOT know its own prefix).
- **FND-8.2** THE SYSTEM SHALL attach middleware that applies to only one group (e.g. OIDC auth, SNS signature verification) inside that group via `.use()`, never in the main app.
- **FND-8.3** THE SYSTEM SHALL build each worker's main app in `src/http/app.ts` that registers only global middleware (request ID, error mapping, logging) and mounts every group with `app.route('<prefix>', group)`; the main app SHALL NOT define route handlers directly.
- **FND-8.4** THE SYSTEM SHALL type every group and the main app with the worker's shared `AppEnv` (`Bindings` + `Variables`), so group middleware and handlers see the same typed context.

### FND-9 — Structured logging
As an operator, I want every log line in one consistent structured format with extra fields, so that logs are searchable in Workers Logs.

- **FND-9.1** THE SYSTEM SHALL log only through the `Logger` class in `packages/shared`; runtime code in `apps/*` and `packages/*` SHALL NOT call `console.*` directly (enforced by the linter; the logger's own sink is the single exception).
- **FND-9.2** THE SYSTEM SHALL provide `debug`, `info`, `warn` and `error` methods taking `(message, metadata?)`, each writing exactly one JSON line containing `timestamp` (ISO 8601), `level`, `message`, the logger's context fields and the metadata fields.
- **FND-9.3** WHEN `Logger.root` is read THE SYSTEM SHALL return the shared default logger, creating and storing it on the class on first access.
- **FND-9.4** WHEN `logger.child(context)` is called THE SYSTEM SHALL return a logger whose entries include the parent's context plus `context`, without changing the parent.
- **FND-9.5** THE SYSTEM SHALL serialize `Error` values found in metadata as `{ name, message, stack, cause? }` (recursively for `cause`).
- **FND-9.6** THE SYSTEM SHALL NOT let context or metadata overwrite `timestamp`, `level` or `message`.
- **FND-9.7** WHEN metadata cannot be serialized (e.g. circular references) THE SYSTEM SHALL still write the entry, replacing the offending values with `"[unserializable]"`, and SHALL never throw from a log call.

## Non-functional requirements

- Node.js LTS for tooling; Workers `compatibility_date` pinned in each `wrangler.jsonc` and bumped deliberately.
- `nodejs_compat` flag enabled on platform workers only where a dependency requires it.
- No local development environment: platform workers are never run with `wrangler dev`. Code is verified by Vitest (unit + `vitest-pool-workers` integration tests, which run in-process and need no setup) and by e2e tests on the deployed dev environment (spec 12). External systems (GitHub, Cloudflare API, SES, Resend) sit behind interfaces with fakes for unit/integration tests.

## Out of scope

- Staging or preview environments.
- Infrastructure-as-code for Cloudflare/AWS/GitHub resource creation (created manually once per environment and documented in design.md; may be automated later).
