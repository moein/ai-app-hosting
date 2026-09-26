# 00 — Foundation: Tasks

- [x] **1. Initialize workspace**
  Root `package.json` (scripts: `lint`, `format`, `typecheck`, `test`; `check:wrangler` is added in task 4, `deps:check` in task 7), `pnpm-workspace.yaml`, `.npmrc` (`save-exact=true`), `.gitignore` (incl. `.dev.vars` as a safety net, `.wrangler/`, `node_modules/`), `tsconfig.base.json` (strict), `biome.json`. Verify latest versions with `npm view` before pinning.
  Satisfies: FND-1.1, FND-1.2, FND-1.3, FND-1.4, FND-5.1, FND-2.4
  Tests: `pnpm lint`, `pnpm typecheck` and `pnpm test` run across workspaces and fail when a workspace fails (verified with a deliberately failing sample test, then removed).

- [x] **2. `packages/shared`: ids**
  `newId`, `isId`, branded ID types.
  Satisfies: FND-3.1, FND-3.2, FND-3.3
  Tests: format regex for every prefix; 10k generated IDs are unique; `isId` rejects wrong prefix, wrong length, illegal chars.

- [x] **3. `packages/shared`: errors, limits, time**
  `ErrorCode`, `PlatformError`, `ERROR_CATALOG`, `toPlatformError`; `limits.ts` skeleton; `Clock` + duration parser.
  Satisfies: FND-4.1, FND-4.2, FND-4.3
  Tests: every catalog code has non-empty hint; `toPlatformError(new Error('x'))` → `INTERNAL` without stack; duration parser cases.

- [x] **4. Worker skeletons with `wrangler.jsonc`**
  `apps/api`, `apps/dispatcher`, `apps/tail`, `apps/email` each with `wrangler.jsonc` (`account_id`, `env.dev`, `env.prod` only), a Hono/entrypoint stub, Zod env validation (`createEnvParser` in `packages/shared`), `wrangler types`-generated `Env`, `vitest-pool-workers` config, and `check:wrangler`. Per-env Cloudflare resources (FND-2.3) are created and bound by the task that first needs them (D1 in task 6, the rest in their feature specs). Skeletons deployed to dev.
  Satisfies: FND-2.1, FND-2.2, FND-2.3, FND-2.5
  Tests: each worker's health stub responds in pool-workers test; env validation test with a missing var returns `INTERNAL` and log names the var; `check:wrangler` script fails when a `wrangler.toml` or `wrangler.json` fixture is present.

- [x] **5. Hono route-group skeleton in `apps/api`**
  `src/http/env.ts` (`AppEnv`), `src/http/app.ts` (requestId + errorHandler + mounts), `src/http/routes/health.ts`, `src/http/middleware/{requestId,errorHandler}.ts`; `src/index.ts` exports `app.fetch`.
  Satisfies: FND-8.1, FND-8.2, FND-8.3, FND-8.4
  Tests: `healthRoutes.request('/')` works in isolation; `GET /healthz` through the main app works and carries a request-ID header; test asserting every route in `app.routes` starts with a mounted group prefix; a group-scoped test middleware runs for its group only (not for `/healthz`).

- [x] **6. Structured `Logger`**
  `packages/shared/src/logger.ts` (`Logger.root`, `child`, levels, Error serialization); replace every `console.*` in `apps/*` and `packages/*`; Biome `noConsole` as error with an override for the logger sink; `scripts/` use `process.stdout/stderr.write`.
  Satisfies: FND-9.1, FND-9.2, FND-9.3, FND-9.4, FND-9.5, FND-9.6, FND-9.7
  Tests: one JSON line per call with timestamp/level/message + metadata; each level uses the matching console method; `Logger.root` returns the same instance on every access; child merges context without mutating the parent; Error (with cause) serialized; reserved fields can't be overwritten; circular metadata doesn't throw; lint fails on a stray `console.log` (verified once).

- [x] **7. Platform D1 + Drizzle**
  `platform-db-dev` / `platform-db-prod` (location `weur`) bound as `DB`; `apps/api/src/db/schema.ts` (empty-but-wired), `src/db/client.ts`, `drizzle.config.ts` (`pnpm db:generate`), `migrations/`, test setup applying migrations; worker types generated from the dev env shape (`wrangler types --env dev --strict-vars=false`).
  Satisfies: FND-6.1, FND-6.2, FND-6.3
  Tests: a pool-workers test sees migrated schema (e.g. `sqlite_master` contains expected tables once later specs add them).

- [ ] **8. Dependency check script**
  `scripts/deps-check.ts` for `pnpm deps:check`.
  Satisfies: FND-5.2, FND-5.3
  Tests: unit test on parser with a fake `pnpm outdated` JSON payload.

- [x] **9. CI checks + terminal deploy script**
  `.github/workflows/ci.yml` (checks only, no secrets); `scripts/deploy.mjs` behind `pnpm deploy:dev` / `pnpm deploy:prod`: checks → migrations → workers in order → e2e (dev); prod guard (clean tree, on pushed `main`).
  Satisfies: FND-7.1, FND-7.2, FND-7.3, FND-7.4
  Tests: CI green on the first push; `pnpm deploy:dev` deploys all workers and `/healthz` answers; `pnpm deploy:prod` refuses with a dirty tree (verified once); a failing check stops the deploy before any upload (verified once).

- [x] **10. Fill in CLAUDE.md "Commands"** with the real commands.
  Satisfies: (docs)

- [x] **11. E2E on dev** (spec 12, after spec 12 task 1)
  Flows: `F-FND-1`.
  Satisfies: E2E-3.3
