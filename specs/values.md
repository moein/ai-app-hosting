# Values

This is the only place for the concrete values behind the placeholders used in specs. Specs, guide text and docs always use the placeholder. When a value changes, only this file and the `vars` in each worker's `wrangler.jsonc` change. Code never hard-codes these values; it reads them from worker `vars`.

## Placeholders

| Placeholder | Meaning | dev | prod |
|---|---|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ("Ai app hosting") owning every platform resource; set as `account_id` in every `wrangler.jsonc`. Not a secret. | `ebdcbd8e905ff028ba30a0104288f65e` | same |
| `PLATFORM_API_ORIGIN` | Origin of the platform API / MCP server. For now the Cloudflare-generated `workers.dev` URL of the `api-<env>` worker; a custom domain may replace it later. | `https://api-dev.ai-app-hosting.workers.dev` | `https://api-prod.ai-app-hosting.workers.dev` |
| `APPS_DOMAIN` | Domain hosting user apps (`<slug>.APPS_DOMAIN`). A Cloudflare zone (its apex) with a wildcard route to the dispatcher. Each environment has its own domain. Each app also sends email from its own SES identity `mail.<slug>.APPS_DOMAIN` (spec 11). | `motad.app` | _to be chosen_ |
| `PLATFORM_MAIL_DOMAIN` | Resend-verified domain for platform emails (login codes, sent from `login@PLATFORM_MAIL_DOMAIN`). Its own `vars` entry in `apps/email/wrangler.jsonc`, separate from the apps' mail domains, so app sending reputation can't hurt login-code delivery. | `ideep.app` | `ideep.app` |
| `PLATFORM_WEBSITE_URL` | Where the apex and `www.` of `APPS_DOMAIN` redirect. Empty means those hosts get the 404 page (the homepage is a separate project). | _(empty)_ | _(empty)_ |
| `GITHUB_ORG` | GitHub organization that owns all app repos (dev repos are prefixed `dev-`). | `AI-app-hosting` | `AI-app-hosting` |
| `AWS_REGION` | AWS region for SES (customer app email). | `eu-central-1` (Frankfurt) | `eu-central-1` (Frankfurt) |
| `E2E_INBOX_ADDRESS` | Address whose mail is routed (one Cloudflare Email Routing rule on the `APPS_DOMAIN` zone apex, **subaddressing enabled**) to the dev-only `e2e-inbox` worker (spec 12). Tests use `<local>+<runId>-<n>@<domain>`. Not a catch-all: no other address on the zone is affected. | `e2e@motad.app` | — (never set) |

Notes:
- The account's `workers.dev` subdomain is `ai-app-hosting`.
- Reserved slugs (spec 01) such as `mail`, `www`, `api` and `e2e` can never become app hostnames under `APPS_DOMAIN`.
- Email Routing can't be enabled on a subdomain here, which is why the e2e inbox is a single subaddressed address on the apex rather than a whole domain.
- `motad.app` (dev user apps) and `ideep.app` (platform email) are temporary domains. The prod `APPS_DOMAIN` is not chosen yet: prod `vars` hold an empty value, which env validation rejects, so prod can't start until it is set.

## Derived endpoints

| Endpoint | Value |
|---|---|
| MCP server (what users paste into their AI client) | `PLATFORM_API_ORIGIN/mcp` |
| Build callbacks (spec 08) | `PLATFORM_API_ORIGIN/v1/builds/*` |
| OIDC audience for builds (spec 08) | `PLATFORM_API_ORIGIN` |
| SES events webhook (spec 11) | `PLATFORM_API_ORIGIN/v1/ses/events` |
| User app | `https://<slug>.APPS_DOMAIN` |
| App sender address (spec 11) | `hello@mail.<slug>.APPS_DOMAIN` |
