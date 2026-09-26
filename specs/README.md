# Specs

Specs are the single source of truth. Code follows specs; when requirements change, the spec changes first (see `/CLAUDE.md`).

## Feature index

Implement roughly in this order; later specs depend on earlier ones.

| # | Feature | AC prefix | Summary |
|---|---|---|---|
| 00 | [foundation](00-foundation/) | `FND` | Monorepo, dev/prod environments, `wrangler.jsonc` per worker, D1 migrations, IDs, errors, CI |
| 01 | [slugs](01-slugs/) | `SLUG` | Subdomain-safe unique slugs for orgs and apps |
| 02 | [identity-and-auth](02-identity-and-auth/) | `AUTH` | Email-code login via MCP tools, MCP session binding, signup → personal org |
| 03 | [organizations-and-apps](03-organizations-and-apps/) | `APP` | Org/app model, app provisioning, delete (Worker only), quotas |
| 04 | [mcp-server](04-mcp-server/) | `MCP` | Tool catalog, server instructions, platform guide, result/error contract |
| 05 | [event-tracking-and-metrics](05-event-tracking-and-metrics/) | `EVT` | Every MCP action → Pipeline → R2; metrics → Analytics Engine |
| 06 | [app-contract](06-app-contract/) | `CON` | Rules AI-written apps must follow; contract validator |
| 07 | [source-repositories](07-source-repositories/) | `SRC` | GitHub App, one repo per app, read/write files via MCP |
| 08 | [build-and-deploy](08-build-and-deploy/) | `DEP` | Actions build, OIDC upload, D1 migrations, WfP deploy, rollback |
| 09 | [app-runtime](09-app-runtime/) | `RUN` | Dispatcher, subdomain routing, bindings, secrets, limits |
| 10 | [logs](10-logs/) | `LOG` | Build logs and runtime logs for the AI |
| 11 | [email](11-email/) | `MAIL` | Platform email via Resend; customer app email via SES (tenant per org), bounces |
| 12 | [e2e-testing](12-e2e-testing/) | `E2E` | E2E suite on deployed dev for every flow; real test inbox. **Implement right after 00.** |

Deferred work: [backlog.md](backlog.md).

## Architecture overview

```
 User ──chat──▶ AI client (Claude / ChatGPT / any MCP client)
                     │  MCP (Streamable HTTP)
                     ▼
        ┌──────────────────────────── PLATFORM_API_ORIGIN ─────────────────────────────┐
        │ apps/api Worker                                                              │
        │  /mcp ──▶ McpSession DO (per MCP session: auth binding, client info)         │
        │  /v1/builds/* ◀── GitHub Actions (OIDC)                                      │
        │  /v1/ses/events ◀── SNS (bounces/complaints)                                 │
        │  Workflows: ProvisionApp, DeployApp      Queue → email-jobs (apps/email)    │
        └───┬──────────┬───────────┬──────────┬───────────┬──────────┬────────────────┘
            │          │           │          │           │          │
         D1 platform  KV routes   R2 artifacts Pipeline   Analytics  GitHub App ──▶ github.com/<GITHUB_ORG>/<slug>
                                              (→ R2 events) Engine                       │ push to main
                                                                                          ▼
                                                                          GitHub Actions (managed deploy.yml)
                                                                          validate → build → upload artifact
            ┌──────────────────── *.APPS_DOMAIN ─────────────────────┐
 Visitor ──▶│ apps/dispatcher ──▶ dispatch namespace `apps-<env>`     │
            │                      └─ user Worker <slug>              │──bindings──▶ DB (per-app D1), ASSETS, EMAIL (apps/email AppMail)
            └─────────────────────────────────────────────────────────┘
                                   │ tail events
                                   ▼
                     apps/tail ──▶ AppLogBuffer DO (per app)  +  Pipeline (→ R2 logs archive)

 apps/email ──▶ Resend (platform login codes, login@PLATFORM_MAIL_DOMAIN)
            └─▶ AWS SES v2 (customer app email, tenant per org, <slug>@APPS_MAIL_DOMAIN)

 e2e/ (CI or any machine) ──MCP──▶ PLATFORM_API_ORIGIN (dev) · reads real emails from apps/e2e-inbox (dev only)
```

## Glossary

| Term | Meaning |
|---|---|
| **AI client** | Any MCP-capable assistant acting for the user (Claude, ChatGPT, …). It writes all app code. |
| **User** | A person identified by email. |
| **Organization (org)** | Owner of apps. Every user gets a *personal org* at signup. Hidden from the MCP API in v1. |
| **App** | A hosted full-stack application: one GitHub repo, one D1 database, one Worker script, one subdomain. |
| **Slug** | Globally unique, DNS-label-safe identifier of an org or app. App slug = subdomain. |
| **App contract** | The rules an app's code must follow to be built and run by the platform (spec 06). |
| **Managed files** | Files the platform owns in each app repo (`.github/workflows/deploy.yml`, `platform.json`). The AI cannot modify them. |
| **Deployment** | One attempt to build and ship a commit (or re-ship an artifact, for rollback). |
| **Artifact** | Build output uploaded by the workflow and stored in R2: Worker modules, static assets, migrations. |
| **Dispatch namespace** | Workers for Platforms namespace holding all user Workers (`apps-dev`, `apps-prod`). |
| **MCP session** | One Streamable-HTTP MCP session (`Mcp-Session-Id`), backed by a `McpSession` Durable Object. Login is bound to it. |
| **SES tenant** | AWS SES v2 tenant isolating an org's sending reputation. |

## Placeholders

Specs never contain concrete domains or account names. They use placeholders (`PLATFORM_API_ORIGIN`, `APPS_DOMAIN`, `APPS_MAIL_DOMAIN`, `PLATFORM_MAIL_DOMAIN`, `PLATFORM_WEBSITE_URL`, `GITHUB_ORG`, `E2E_INBOX_ADDRESS`); their meanings and current values live in one file: [values.md](values.md).

## Spec conventions

**requirements.md**
- User stories: "As a *role*, I want *capability*, so that *benefit*."
- Acceptance criteria in EARS style — `WHEN <trigger> THE SYSTEM SHALL <response>`, `IF <condition> THEN THE SYSTEM SHALL …`, `THE SYSTEM SHALL …` (ubiquitous).
- Every criterion has a stable ID `<PREFIX>-<story>.<n>` and must be verifiable by an automated test. IDs are never reused; removed criteria are struck through, not renumbered.
- Sections: Stories & acceptance criteria, Non-functional requirements, Out of scope.

**design.md**
- Architecture (ASCII diagrams), data model (D1 tables/columns), contracts (Zod-like shapes), error codes, sequence flows, security notes, **Open questions**.

**tasks.md**
- Ordered `- [ ]` checklist. Each task: small enough for one session, lists `Satisfies:` AC IDs and `Tests:` it adds. Tick (`- [x]`) when merged.

## Traceability (brief → specs)

| # | Requirement from the product brief | Covered by |
|---|---|---|
| 1 | Anyone without technical knowledge can host a full-stack app from an AI chat (mobile or browser) | 04 (`MCP-1`, `MCP-2`), 06 (`CON-1`) |
| 2 | Works with any MCP-capable AI client, not only Claude | 04 (`MCP-1.1`–`MCP-1.4`) |
| 3 | MCP supports signup/signin | 02 (`AUTH-1`, `AUTH-2`) |
| 4 | Login = AI asks for email, user relays the emailed code | 02 (`AUTH-1.1`, `AUTH-2.1`) |
| 5 | MCP supports pushing code | 07 (`SRC-2`, `SRC-3`) |
| 6 | MCP supports checking logs | 10 (`LOG-1`, `LOG-2`) |
| 7 | MCP supports other actions the AI needs (deployments, secrets, database) | 04 (`MCP-3`), 08 (`DEP-3`, `DEP-4`), 09 (`RUN-3`, `RUN-4`) |
| 8 | Each app gets its own GitHub repository | 07 (`SRC-1`) |
| 9 | Apps are hosted on Cloudflare Workers | 08 (`DEP-2`), 09 (`RUN-1`) |
| 10 | Personal org created at signup; org hidden from UI/API in v1 | 02 (`AUTH-2.4`), 03 (`APP-1`), 04 (`MCP-1.5`) |
| 11 | An org can have multiple apps | 03 (`APP-2`, `APP-5`) |
| 12 | MCP tells the AI exactly what to ship | 04 (`MCP-2`), 06 (`CON-1`, `CON-2`) |
| 13 | The platform never generates app code | 06 (`CON-1.1`), 07 (`SRC-1.2`) |
| 14 | Platform runs on Workers + D1 + Analytics Engine | 00 (`FND-2`), 05 (`EVT-2`) |
| 15 | Every MCP action tracked to a pipeline and dumped into R2 | 05 (`EVT-1`) |
| 16 | Important platform metrics sent to Analytics Engine | 05 (`EVT-2`) |
| 17 | Email via AWS SES; one tenant per org | 11 (`MAIL-1`, `MAIL-2`) |
| 18 | Unique, subdomain-valid slugs for apps and orgs | 01 (`SLUG-1`, `SLUG-2`, `SLUG-3`) |
| 19 | Deleting an app deletes only its Worker | 03 (`APP-4`) |
| 20 | Platform uses `wrangler.jsonc`; latest React and Hono | 00 (`FND-2.2`, `FND-5`), 06 (`CON-2.3`) |
| 21 | Environments are dev and prod only | 00 (`FND-2.1`) |
| 22 | IDs are prefixed nanoid(11) | 00 (`FND-3`) |
| 23 | Spec-first workflow with specs/ and CLAUDE.md | `/CLAUDE.md`, this file |
| 24 | Every flow has e2e tests runnable on dev; no local setup | 12 (`E2E-1`–`E2E-3`), 00 (`FND-7.2`, `FND-2.4`) |
| 26 | Deploys run from the terminal with authenticated wrangler; CI only checks | 00 (`FND-7`) |
| 25 | Platform emails via Resend; SES only for customer apps | 11 (`MAIL-3`, `MAIL-2`) |
