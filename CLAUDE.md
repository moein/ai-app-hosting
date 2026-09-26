# CLAUDE.md

## Standing rule

**Always read and update the relevant spec before writing code.**

## What this is

A hosting platform for people with no technical background. A user talks to **any MCP-capable AI client** (Claude, ChatGPT, …); that AI signs the user up, writes the app's code, and ships it through our remote MCP server. Each app gets its own GitHub repository (in our GitHub org) and runs on Cloudflare Workers for Platforms at `<app-slug>.<APPS_DOMAIN>`.

**The platform never generates app code.** All user app code is written by the user's AI client. We store it, validate it against the published *app contract*, build it, deploy it, host it, and give the AI the tools to operate it (logs, secrets, database, email).

Start with `specs/README.md` — architecture overview, glossary, feature index and traceability.

## Spec-driven workflow

Specs live in `specs/<NN-feature>/`:
- `requirements.md` — user stories + EARS acceptance criteria with stable IDs (e.g. `SLUG-1.3`).
- `design.md` — architecture, data model, contracts, error codes, open questions.
- `tasks.md` — ordered checklist; each task lists the AC IDs it satisfies and the tests that prove them.

The loop:
1. Draft or update the spec from the idea.
2. The human reviews and edits it.
3. Implement **one task at a time** from `tasks.md`, write the tests it names, tick it (`- [x]`).
4. When requirements change, change the spec first; the code follows. The spec is the single source of truth.

If implementation reveals the spec is wrong or incomplete, stop and update the spec (and say so) rather than silently diverging.

**Every user-facing flow has an e2e test that runs against the deployed dev environment** (spec 12). A feature is done only when its E2E task passes on dev. There is no local environment: never use `wrangler dev` or `.dev.vars`; verify with Vitest (unit + `vitest-pool-workers`) and e2e on dev.

## Platform stack

- TypeScript (strict), pnpm workspaces, Biome (lint + format).
- Cloudflare Workers, configured with **`wrangler.jsonc`** (never `.toml` or `.json`).
- Hono for HTTP routing.
- `agents` SDK — `McpAgent` over Streamable HTTP; one Durable Object per MCP session.
- D1 + Drizzle ORM (migrations generated with drizzle-kit, applied with wrangler).
- Cloudflare Workflows (durable provisioning/deploy), Queues, KV, R2, Pipelines, Analytics Engine, Workers for Platforms.
- Zod at every boundary (MCP tool input, HTTP bodies, env, external API responses).
- `nanoid` for IDs.
- Tests: Vitest. Plain Vitest for pure logic; `@cloudflare/vitest-pool-workers` for integration tests that need real D1 / Durable Object / KV / R2 bindings.
- Environments: **`dev` and `prod` only**. No local environment.
- Email: **Resend** for platform emails (login codes, from `login@PLATFORM_MAIL_DOMAIN`); **AWS SES** only for customer apps' emails (tenant per org).

### Dependency rule

Always use the latest stable version. Before adding or upgrading a dependency, check `npm view <pkg> version`, and pin exact versions. Baseline as of 2026-09-26:

| Package | Version |
|---|---|
| react | 19.3.0 |
| hono | 4.13.9 |
| wrangler | 4.141.0 |
| vite | 8.3.1 |
| @cloudflare/vite-plugin | 1.60.2 |
| agents | 0.24.0 |
| @modelcontextprotocol/sdk | 1.30.0 (pinned to the exact peer version `agents` 0.24.0 requires) |
| drizzle-orm | 0.45.3 |
| zod | 4.6.5 |
| nanoid | 6.0.1 |
| vitest | 4.1.11 (latest 4.x — `@cloudflare/vitest-pool-workers` 0.22 requires `vitest ^4.1`; move to 5 when it supports it) |
| @cloudflare/vitest-pool-workers | 0.22.0 |

## Repo layout (planned — see specs/00-foundation)

```
apps/api            MCP server (/mcp), build callbacks (/v1/builds/*), SES webhooks, Workflows, queue consumer
apps/dispatcher     Routes *.APPS_DOMAIN to user Workers in the dispatch namespace
apps/tail           Tail consumer for user Workers; hosts the AppLogBuffer Durable Object
apps/email          PlatformMail (Resend) + AppMail (SES) RPC entrypoints; SES tenant queue consumer
apps/e2e-inbox      Dev-only: receives e2e test emails via Email Routing (spec 12)
packages/shared     IDs, error codes, limits, Logger, env validation, Zod schemas, slugs
packages/http       Hono helpers shared by workers (requestId, errorHandler, notFoundHandler, errorResponse)
packages/app-contract  Guide text, contract validator, managed deploy.yml + platform.json
fixtures/contract-app  Minimal app used ONLY in our tests to exercise build/deploy. Never given to users.
e2e/                E2E suite, runs against deployed dev (`pnpm e2e`)
specs/              Specs (source of truth)
```

## Conventions

- **IDs**: `<prefix>_<nanoid(11)>`, e.g. `usr_V1StGXR8_Z5`. Prefixes: `usr_`, `org_`, `app_`, `dep_`, `evt_`, `lc_` (login code). Generate only via `packages/shared` `newId(prefix)`.
- **Time**: UTC epoch milliseconds (`INTEGER`) everywhere in storage and APIs; ISO 8601 only in human-facing text.
- **Errors**: every failure is a typed `{ code, message, hint, retryable, details? }`. `hint` tells the AI what to do next. Codes live in `packages/shared/errors.ts`; never invent ad-hoc codes.
- **Logging**: only via `Logger` from `@repo/shared` — `Logger.root.info(message, metadata)` or a `child({ ... })` logger. Never call `console.*` directly (lint error).
- **Tracking**: every MCP tool call emits exactly one tracking event (spec 05). Never log login codes, secret values or file contents.
- **Organizations** exist in the data model but are hidden from the MCP API in v1 (no org IDs in tool inputs/outputs).
- **Client-agnostic**: use only core MCP features (tools + server `instructions`). No Claude- or ChatGPT-specific behavior.
- **Secrets**: never in code or `wrangler.jsonc`. The operator keeps them in git-ignored `.env.dev` / `.env.prod` (template: `.env.example`) and uploads them with `pnpm secrets:<env>`.
- **Hono route groups**: every group of related routes is its own `Hono` instance in `src/http/routes/<group>.ts`, with the group's middleware attached inside it and paths relative to the group. The main app (`src/http/app.ts`) only adds global middleware and mounts groups with `app.route('<prefix>', group)`; it defines no routes itself. See specs/00-foundation/design.md "HTTP routing".
- **Placeholders**: specs use `PLATFORM_API_ORIGIN`, `APPS_DOMAIN`, `APPS_MAIL_DOMAIN`, `PLATFORM_MAIL_DOMAIN`, `PLATFORM_WEBSITE_URL`, `GITHUB_ORG`, `E2E_INBOX_ADDRESS`; their concrete values live only in `specs/values.md`. Never write concrete domains into specs or code — code reads them from worker `vars` in `wrangler.jsonc`.
- **Limits** (sizes, quotas, rate limits) are constants in `packages/shared/limits.ts`, referenced by specs by name.

## Commands

```
pnpm install              # install everything (Node 24, pnpm 10)
pnpm lint                 # Biome (pnpm format to auto-fix)
pnpm typecheck            # tsc in every workspace
pnpm test                 # Vitest in every workspace (unit + vitest-pool-workers)
pnpm check:wrangler       # fails on wrangler.toml / wrangler.json
pnpm deploy:dev           # checks → D1 migrations → deploy all workers to dev → e2e (from your terminal, authenticated wrangler)
pnpm e2e [pattern]        # e2e suite against deployed dev (settings from .env.dev)
pnpm deploy:prod          # same for prod; requires a clean tree on pushed main
pnpm secrets:dev          # upload Worker secrets for dev from .env.dev (values never printed); generates missing dev-only/pepper secrets.
                          # Run it BEFORE the deploy that first needs a new secret — workers reject requests while a required secret is missing.
pnpm -F @repo/api db:generate   # Drizzle: generate a SQL migration from src/db/schema.ts
pnpm -F @repo/<worker> types    # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

CI (GitHub Actions) only runs checks; it has no secrets and never deploys.
