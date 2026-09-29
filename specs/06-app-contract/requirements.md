# 06 — App Contract: Requirements

The platform never generates app code. The user's AI writes every file. The **app contract** is the precise, versioned set of rules that AI-written code must satisfy so the platform can build and run it: one Cloudflare Worker serving a Hono API under `/api/*` and a Vite + React single-page app as static assets, with a D1 database accessed via Drizzle, configured by `wrangler.jsonc`.

The contract is delivered to the AI through `get_platform_guide` (spec 04) and enforced by a validator that runs first in every build.

## Stories & acceptance criteria

### CON-1 — The contract is the AI's source of truth
As an AI client, I want one precise description of what to write, so that my first build succeeds.

- **CON-1.1** THE SYSTEM SHALL NOT provide templates, starter repos, scaffolding tools or any generated application code; the only files the platform writes into an app repo are the managed files `.github/workflows/deploy.yml` and `platform.json`.
- **CON-1.2** THE SYSTEM SHALL publish the contract as the `contract` topic of `get_platform_guide`, labeled with `contract_version` (v1 = `"1"`).
- **CON-1.3** THE SYSTEM SHALL include in the contract, for every rule, the rule ID, the requirement, and how to fix a violation.
- **CON-1.4** THE SYSTEM SHALL include in the contract the exact required content of `wrangler.jsonc` and `vite.config.ts` (as reference text the AI must write itself), since these files must match exactly.

### CON-2 — Required structure
As the platform, I want every app to have the same shape, so that one build pipeline and one runtime configuration fit all apps.

- **CON-2.1** THE SYSTEM SHALL require these files: `package.json`, `wrangler.jsonc`, `vite.config.ts`, `index.html`, `tsconfig.json`, `src/api/index.ts`, `src/web/main.tsx`.
- **CON-2.2** THE SYSTEM SHALL require `package.json` to have `"type": "module"`, `"private": true`, and a `scripts.build` equal to `vite build`; `scripts.typecheck`, if present, SHALL be run during the build.
- **CON-2.3** THE SYSTEM SHALL require these dependencies at or above these versions: `react` 19.3.0, `react-dom` 19.3.0, `hono` 4.13.0 (dependencies); `vite` 8.0.0, `@cloudflare/vite-plugin` 1.60.0, `@vitejs/plugin-react`, `typescript`, `@cloudflare/workers-types` (devDependencies). `drizzle-orm` is the only supported ORM and is optional.
- **CON-2.4** THE SYSTEM SHALL require `wrangler.jsonc` to have `name: "app"`, `main: "src/api/index.ts"`, a `compatibility_date` within the platform's supported window, `assets.not_found_handling: "single-page-application"`, `assets.run_worker_first` containing `"/api/*"`, and exactly one D1 binding named `DB`.
- **CON-2.5** THE SYSTEM SHALL reserve binding names `DB` (D1), `FILES` (the app's R2 bucket, spec 15), `ASSETS` (static assets) and `EMAIL` (email service); the app SHALL NOT declare `FILES`, `EMAIL` or `ASSETS` itself — the platform injects them at deploy time.
- **CON-2.6** THE SYSTEM SHALL require D1 migrations to live in `migrations/` with filenames matching `^\d{4}_[a-z0-9_]+\.sql$` and unique numeric prefixes.
- **CON-2.7** THE SYSTEM SHALL require `src/api/index.ts` to default-export an object with a `fetch` handler (e.g. a Hono app) that serves API routes under `/api/`.
- **CON-2.8** THE SYSTEM SHALL require `index.html` at the repo root referencing `/src/web/main.tsx` as a module script.

### CON-3 — Forbidden content
As the platform, I want to reject code that can't run or is unsafe, so that failures are caught early with clear fixes.

- **CON-3.1** THE SYSTEM SHALL reject repos containing `wrangler.toml`, `wrangler.json`, `node_modules/`, `dist/`, `.dev.vars`, `.env` or `.env.*`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` or `bun.lock`.
- **CON-3.2** THE SYSTEM SHALL reject dependencies on the denylist in design.md (Node-only or unsupported packages), each violation naming the recommended alternative.
- **CON-3.3** THE SYSTEM SHALL reject `wrangler.jsonc` keys that the platform doesn't support in v1 (any binding type other than `d1_databases`; `routes`, `route`, `triggers`, `env`, `workers_dev`, `durable_objects`, `migrations`, `tail_consumers`, `services`, `observability`, `limits`), each violation explaining that the feature isn't available yet.
- **CON-3.4** THE SYSTEM SHALL allow `vars` in `wrangler.jsonc` only as string values, and SHALL reject names that collide with reserved bindings or secrets.

### CON-4 — Validator
As an AI client, I want every violation reported at once with a fix, so that I can correct everything in one write.

- **CON-4.1** THE SYSTEM SHALL implement the validator as a pure function `validate(files) → Violation[]` in `packages/app-contract`, used unchanged by the build workflow and by tests.
- **CON-4.2** THE SYSTEM SHALL report all violations in one run, not just the first.
- **CON-4.3** THE SYSTEM SHALL give every violation `{ rule, path, message, fix }`, where `rule` is a contract rule ID.
- **CON-4.4** WHEN run as a CLI THE SYSTEM SHALL print violations as JSON and exit with code 1 if any exist, else exit 0.
- **CON-4.5** THE SYSTEM SHALL run the validator before dependency installation in the build (spec 08), and a failing validation SHALL fail the deployment with `CONTRACT_VIOLATION` and the violation list.
- **CON-4.6** IF `platform.json.contract_version` is not supported by the validator THEN THE SYSTEM SHALL report a violation.

### CON-5 — Test fixture
As a platform developer, I want a known-good app, so that the pipeline is tested end-to-end.

- **CON-5.1** THE SYSTEM SHALL keep a minimal contract-compliant app in `fixtures/contract-app` that passes the validator and builds with `vite build`.
- **CON-5.2** THE SYSTEM SHALL use `fixtures/contract-app` only in tests; no code path SHALL copy it (or any part of it) into user repos.

## Non-functional requirements

- Validator runs in < 2 s on a 2,000-file repo.
- Contract changes that would break existing apps require a new `contract_version`; the validator supports the current and previous version.

## Out of scope (v1)

- Other frameworks (Next.js, Remix, SSR), other languages.
- KV, R2, Durable Objects, Queues, cron triggers, custom domains for apps.
- User authentication helpers for apps (the AI implements app-level auth itself; guide may give patterns later).
