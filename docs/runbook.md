# Operator runbook

One-time setup and recurring operations per environment (`dev`, `prod`). Concrete values (account id, domains, org) are in `specs/values.md`; this file only says *how*. Secrets live in the git-ignored `.env.<env>` (template `.env.example`) and are never printed or committed.

## 0. Prerequisites

- `wrangler login` on the operator machine (deploys run from the terminal; CI never deploys).
- `.env.<env>` filled from `.env.example`.
- `pnpm install`.

## 1. Cloudflare

| What | How |
|---|---|
| Account | Workers Paid + Workers for Platforms enabled. **R2 and Analytics Engine must be enabled in the dashboard** (artifacts bucket, event/log archives; `METRICS`). |
| API token → `CF_API_TOKEN` | Account: Workers Scripts Edit, Workers for Platforms Edit, D1 Edit, Queues Edit. Zone (`APPS_DOMAIN` zone): DNS Edit. |
| D1, KV, queues, dispatch namespace | Created once with wrangler (`d1 create platform-db-<env>`, `kv namespace create`, `queues create email-jobs-<env>`, `dispatch-namespace create apps-<env>`); IDs go into the workers' `wrangler.jsonc`. |
| R2 bucket | `wrangler r2 bucket create artifacts-<env>` (after R2 is enabled). |
| Apps zone (spec 09) | Each environment has its own `APPS_DOMAIN` zone; apps live at `<slug>.APPS_DOMAIN`. Proxied wildcard DNS `*.APPS_DOMAIN` (e.g. `AAAA 100::`) and the apex; the dispatcher routes are declared in `apps/dispatcher/wrangler.jsonc`. SSL/TLS → Always Use HTTPS on, HSTS on. Universal SSL covers apex + `*.APPS_DOMAIN`, so no Advanced Certificate is needed. |
| Public Suffix List | Submit `APPS_DOMAIN` to the PSL once the final domain is chosen (cookie isolation between apps). |

## 2. GitHub App (spec 07)

One App per environment (`ai-app-hosting-<env>`) owned by `GITHUB_ORG`, webhooks **disabled**. Repository permissions: Administration write, Contents write, Workflows write, Actions write, Metadata read. Install it on the org (all repositories) and put into `.env.<env>`:

- `GITHUB_APP_ID` — the App's id.
- `GITHUB_INSTALLATION_ID` — from the installation URL.
- `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM on one line with literal `\n` (`openssl pkcs8 -topk8 -nocrypt -in key.pem | awk 'NF {printf "%s\\n", $0}'`).

## 3. Email

### Resend (platform login codes, spec 11 task 1b)

Verify `PLATFORM_MAIL_DOMAIN` in Resend (SPF, DKIM, DMARC records at the domain's DNS), create an API key per environment → `RESEND_API_KEY`.

### SES (customer apps, spec 11 task 1)

```
node scripts/setup-ses.mjs <env>
```

Idempotent. Creates configuration set `apps-<env>` and a DMARC record at the `APPS_DOMAIN` apex (only if none exists); then the SNS topic `ses-events-<env>` (SignatureVersion 2, SES publish policy), the configuration-set event destination (bounces, complaints) and the HTTPS subscription to `PLATFORM_API_ORIGIN/v1/ses/events`, and writes `SES_EVENTS_TOPIC_ARN` to `.env.<env>`.

Per-app sending identities (`mail.<slug>.APPS_DOMAIN`, 3 DKIM CNAMEs each) are created automatically by the email worker when an app is provisioned; the email worker needs `CF_API_TOKEN` (uploaded by `pnpm secrets:<env>`).

- AWS keys in `.env.<env>`: `AWS_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY` (IAM user `ai-app-hosting`). The account is shared with other projects — the script only touches resources it names.
- The SNS step needs `sns:CreateTopic`, `sns:Subscribe`, `sns:SetTopicAttributes`, `sns:GetTopicAttributes` on `arn:aws:sns:<region>:<account>:ses-events-*`; it is skipped with a message otherwise. Deploy the api first (it confirms the subscription), then run the script, then `pnpm secrets:<env>`.
- SES production access is account-level (already enabled; the script prints it).
- Each org gets tenant `<env>-<org_id>` automatically (email-jobs queue). To retry orgs (tenants) and apps (identities) stuck in `pending`/`failed`: `node scripts/requeue-email-provisioning.mjs <env>`.

### E2E inbox (dev only, spec 12)

Email Routing on the `APPS_DOMAIN` apex, **Subaddressing** on, one rule `E2E_INBOX_ADDRESS` → Send to a Worker → `e2e-inbox-dev` (deploy the worker first).

## 4. Secrets and deploys

```
pnpm secrets:<env>     # uploads every worker secret from .env.<env> (generates missing peppers/tokens)
pnpm deploy:<env>      # checks → D1 migrations → deploy all workers (email, tail, api, dispatcher[, e2e-inbox]) → e2e (dev)
```

Run `pnpm secrets:<env>` before the deploy that first needs a new secret. `deploy:prod` requires a clean tree on pushed `main`.

Deploy order matters: `email-<env>` and `tail-<env>` before `api-<env>` (service binding and the cross-script `APP_LOGS` Durable Object binding).

## 5. Pipelines (spec 05 task 1, spec 10 task 5) — after R2 is enabled

Streams `mcp-events-<env>` and `app-logs-<env>` with R2 Data Catalog sinks in `datalake-<env>` (tables `mcp_events`, `app_logs`); then add the `EVENTS` binding to `apps/api/wrangler.jsonc` and `LOG_ARCHIVE` to `apps/tail/wrangler.jsonc`. Exact commands are recorded here when that task is done.
