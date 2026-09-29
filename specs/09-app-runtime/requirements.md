# 09 — App Runtime: Requirements

User apps run as Worker scripts in a Workers for Platforms dispatch namespace. A dispatcher Worker on `*.APPS_DOMAIN` routes each request to the right app. Apps get exactly the platform-provided bindings (D1 database, static assets, email) plus the secrets and vars their AI configured. The AI can operate the app's secrets and database through MCP tools.

## Stories & acceptance criteria

### RUN-1 — Subdomain routing
As a user, I want my app reachable at `https://<slug>.APPS_DOMAIN`, so that I can share it right away.

- **RUN-1.1** THE SYSTEM SHALL route all requests for `*.APPS_DOMAIN/*` to the dispatcher Worker.
- **RUN-1.2** WHEN a request's host is exactly `<label>.APPS_DOMAIN` THE SYSTEM SHALL treat `<label>` as the app slug; requests to deeper subdomains SHALL get the 404 page; the apex `APPS_DOMAIN` is the homepage (served by the `website` worker, spec 14) and `www.APPS_DOMAIN` SHALL redirect (302) to `PLATFORM_WEBSITE_URL` (the 404 page if it isn't configured).
- **RUN-1.3** THE SYSTEM SHALL resolve the slug through the `APP_ROUTES` KV entry `{ appId, scriptName, state }`.
- **RUN-1.4** WHEN the route state is `live` THE SYSTEM SHALL dispatch the request to `scriptName` in the dispatch namespace with custom limits `cpuMs = APP_CPU_MS_PER_REQUEST` and `subRequests = APP_SUBREQUESTS_PER_REQUEST`.
- **RUN-1.5** WHEN the route state is `not_deployed` THE SYSTEM SHALL return a 503 HTML page saying the app is being built.
- **RUN-1.6** WHEN no route exists for the slug THE SYSTEM SHALL return a 404 HTML page saying there's no app at this address.
- **RUN-1.7** IF dispatching throws (script missing, limit exceeded, uncaught exception) THEN THE SYSTEM SHALL return a 502 HTML page and log the error with app ID.
- **RUN-1.8** THE SYSTEM SHALL serve apps over HTTPS only (HTTP → HTTPS redirect, HSTS).
- **RUN-1.9** THE SYSTEM SHALL reconcile KV routes with D1 hourly: add missing routes for active apps, remove routes for deleted/unknown apps, and fix state mismatches.

### RUN-2 — Bindings and isolation
As the platform, I want each app to reach only its own resources, so that apps can't interfere with each other or with the platform.

- **RUN-2.1** THE SYSTEM SHALL give every deployed app script exactly these bindings: `DB` (the app's own D1 database), `FILES` (the app's own R2 bucket, spec 15), `ASSETS` (its static assets), `EMAIL` (service binding to `email-<env>` entrypoint `AppMail` with props `{ appId, orgId, slug }`), its string `vars`, and its secrets.
- **RUN-2.2** THE SYSTEM SHALL NOT give app scripts any binding to platform resources or another app's resources (platform D1/R2/KV, queues, other apps' databases or buckets).
- **RUN-2.3** THE SYSTEM SHALL run the dispatch namespace in untrusted mode (per-script cache isolation, no `request.cf` sharing across scripts beyond defaults).
- **RUN-2.4** WHEN an app is provisioned THE SYSTEM SHALL upload a placeholder script (no bindings) that returns the 503 "being built" page, so secrets can be set before the first deployment.
- **RUN-2.5** THE SYSTEM SHALL register `APPS_DOMAIN` on the Public Suffix List (operational task) so browsers isolate cookies per app subdomain, and SHALL host user apps on a registrable domain different from the platform API's (`PLATFORM_API_ORIGIN`).

### RUN-3 — Secrets
As a user, I want the AI to store API keys safely, so that my app can call other services without keys in the code.

- **RUN-3.1** WHEN `set_secret({ app, name, value })` is called THE SYSTEM SHALL store the value as a `secret_text` binding on the app's script via the Workers for Platforms secrets API and upsert `{ name, updated_at }` in `app_secrets`.
- **RUN-3.2** IF `name` doesn't match `^[A-Z][A-Z0-9_]{0,63}$`, or equals a reserved binding (`DB`, `ASSETS`, `EMAIL`) or one of the app's `vars` THEN THE SYSTEM SHALL return `SECRET_NAME_INVALID`.
- **RUN-3.3** IF `value` is empty or exceeds `MAX_SECRET_BYTES` THEN THE SYSTEM SHALL return `INVALID_INPUT`.
- **RUN-3.4** WHEN `list_secrets({ app })` is called THE SYSTEM SHALL return names and `updated_at` only — never values.
- **RUN-3.5** WHEN `delete_secret({ app, name })` is called THE SYSTEM SHALL remove the secret from the script and from `app_secrets`; deleting a non-existent secret SHALL succeed (idempotent).
- **RUN-3.6** IF the app has more than `MAX_SECRETS_PER_APP` secrets after the operation THEN THE SYSTEM SHALL return `QUOTA_EXCEEDED`.
- **RUN-3.7** THE SYSTEM SHALL keep secrets across deployments (`keep_bindings`, DEP-2.9) and SHALL apply secret changes to the running app without a redeploy.

### RUN-4 — Database access for the AI
As an AI client, I want to inspect and fix my app's data, so that I can debug problems the user reports.

- **RUN-4.1** WHEN `query_database({ app, sql, params?, allow_writes? })` is called THE SYSTEM SHALL execute a single SQL statement against the app's D1 database and return `{ columns, rows, row_count, truncated, meta: { rows_read, rows_written, duration_ms } }`.
- **RUN-4.2** WHEN `allow_writes` is false (default) IF the statement is not read-only (first keyword not `SELECT`, `EXPLAIN`, or `PRAGMA` with a read-only pragma from the allowlist) or contains more than one statement THEN THE SYSTEM SHALL return `INVALID_INPUT` telling the AI to set `allow_writes: true` after confirming with the user.
- **RUN-4.3** IF a statement would modify `_platform_migrations` or any `_cf_*` table THEN THE SYSTEM SHALL return `INVALID_INPUT`.
- **RUN-4.4** THE SYSTEM SHALL return at most `QUERY_MAX_ROWS` rows and `QUERY_MAX_BYTES` of result, setting `truncated: true` otherwise.
- **RUN-4.5** IF D1 reports an error THEN THE SYSTEM SHALL return `QUERY_FAILED` with D1's error message.

### RUN-5 — Isolation between apps in the browser
As a user, I want other apps on the platform unable to tamper with my app's cookies or ride on my users' sessions, even though all apps share `APPS_DOMAIN`.

`APPS_DOMAIN` is not on the Public Suffix List, so browsers treat every app under it as one "site". The dispatcher enforces the separation instead:

- **RUN-5.1** WHEN an app response sets cookies THE SYSTEM SHALL rewrite each `Set-Cookie` into a host-only cookie: remove `Domain`, set `Path=/`, add `Secure`, and prefix the name with `__Host-` (always, so the name the app sees on later requests is exactly the one it set).
- **RUN-5.2** WHEN forwarding a request to an app THE SYSTEM SHALL pass only cookies whose name starts with `__Host-`, with that prefix removed, and drop all others (cookies planted for the whole `APPS_DOMAIN` can never have the prefix).
- **RUN-5.3** WHEN a request carries `Sec-Fetch-Site: same-site` (it comes from another app under `APPS_DOMAIN`) THE SYSTEM SHALL forward it without cookies.
- **RUN-5.4** THE SYSTEM SHALL add `Origin-Agent-Cluster: ?1` to every app response.
- **RUN-5.5** THE platform guide SHALL tell the AI that cookies are per app, that cookies set in browser JavaScript must be named `__Host-<name>` with `Secure; Path=/`, and that browser code reading `document.cookie` sees server-set cookies with the `__Host-` prefix.

## Non-functional requirements

- Dispatcher overhead p95 < 5 ms (KV read, cached at edge with `cacheTtl: 30`).
- Route changes (deploy, delete) visible globally within 60 s (KV propagation + `cacheTtl`).

## Out of scope

- Custom domains for apps.
- Per-org configurable CPU/subrequest limits, outbound Worker (egress filtering/metering).
- Suspending apps for abuse (see open questions).
- Cron triggers, queues, KV/Durable Objects for apps. (R2: see spec 15.)
