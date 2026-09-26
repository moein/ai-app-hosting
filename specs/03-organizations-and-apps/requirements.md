# 03 — Organizations & Apps: Requirements

Organizations own apps. Every user gets a personal organization at signup (spec 02). Organizations are hidden from the MCP API in v1: every app a user creates goes into their personal org, and tools never take or return org IDs.

An app is a hosted full-stack application made of: one GitHub repo (spec 07), one D1 database, one Worker script in the dispatch namespace (spec 09), and one subdomain.

## Stories & acceptance criteria

### APP-1 — Organizations
As the platform, I want every user to belong to an organization, so that apps, quotas and email tenants have a single owner that can later become a team.

- **APP-1.1** THE SYSTEM SHALL store organizations with a unique ID (`org_…`), a unique slug (spec 01), a display name, `kind` (`personal` in v1), and an email-tenant status (spec 11).
- **APP-1.2** THE SYSTEM SHALL link users to organizations through memberships with role `owner` (the only role in v1).
- **APP-1.3** THE SYSTEM SHALL resolve the acting organization of every authenticated tool call to the user's personal org, stored in the session binding (AUTH-3.1).
- **APP-1.4** THE SYSTEM SHALL NOT accept or return organization IDs or slugs in any MCP tool in v1.

### APP-2 — Create an app
As a user, I want the AI to create a new app for me, so that it has a place to put the code it writes.

- **APP-2.1** WHEN `create_app({ name, slug? })` is called THE SYSTEM SHALL validate `name` (1–60 characters after trimming, no control characters) and return `NAME_INVALID` otherwise.
- **APP-2.2** WHEN `create_app` is called THE SYSTEM SHALL assign a slug (generated from `name`, or the requested `slug` per SLUG-4) and insert the app with `status = 'active'` and `provisioning = 'pending'`.
- **APP-2.3** WHEN an app is inserted THE SYSTEM SHALL start the `ProvisionApp` workflow which, with per-step retries: creates the app's D1 database, creates the GitHub repo containing only the managed files (spec 07), uploads the placeholder Worker script (spec 09), and writes the route to KV; then sets `provisioning = 'ready'`.
- **APP-2.4** WHEN `create_app` is called THE SYSTEM SHALL wait up to 25 seconds for provisioning and return the app (`get_app` shape) with `provisioning` either `ready` or `pending`; IF still pending THEN `next_step` SHALL tell the AI to call `get_app` shortly.
- **APP-2.5** IF provisioning fails after all retries THEN THE SYSTEM SHALL set `provisioning = 'failed'` with an error code, and `get_app` SHALL report it with a hint to call `retry_provisioning`.
- **APP-2.6** WHEN `retry_provisioning({ app })` is called for an app with `provisioning = 'failed'` THE SYSTEM SHALL restart the workflow; each step SHALL be idempotent (skip resources that already exist).
- **APP-2.7** THE SYSTEM SHALL NOT write any application code into the new repo (only managed files, spec 07).
- **APP-2.8** IF the org already has `MAX_APPS_PER_ORG` active apps THEN THE SYSTEM SHALL return `QUOTA_EXCEEDED` with `details.limit = 'apps'`.

### APP-3 — Read apps
As a user, I want the AI to see my apps and their state, so that it can continue work on the right one.

- **APP-3.1** WHEN `list_apps()` is called THE SYSTEM SHALL return the acting org's apps with `status = 'active'`, newest first, each with `slug`, `name`, `url`, `provisioning`, `live_deployment` summary (or null) and `created_at`.
- **APP-3.2** WHEN `get_app({ app })` is called THE SYSTEM SHALL return full details: `slug`, `name`, `url`, `provisioning` (+ error if failed), `live_deployment`, `latest_deployment`, `repo` (`{ default_branch, head_commit_sha }`), `created_at`.
- **APP-3.3** THE SYSTEM SHALL identify apps in every tool by `app` = the app slug (the AI-friendly handle); IF the slug does not belong to the acting org THEN THE SYSTEM SHALL return `NOT_FOUND` (never revealing that it exists elsewhere).
- **APP-3.4** IF a tool other than `get_app` targets a deleted app THEN THE SYSTEM SHALL return `APP_DELETED`; `get_app` on a deleted app SHALL return it with `status: 'deleted'`.
- **APP-3.5** IF a tool that needs provisioned resources targets an app with `provisioning ≠ 'ready'` THEN THE SYSTEM SHALL return `APP_NOT_READY`.

### APP-4 — Delete an app (Worker only)
As a user, I want to take my app offline, so that it's no longer reachable, without losing my code or data.

- **APP-4.1** WHEN `delete_app({ app, confirm_slug })` is called with `confirm_slug` equal to the app slug THE SYSTEM SHALL delete **only** the app's Worker script from the dispatch namespace (which also removes its secrets).
- **APP-4.2** THE SYSTEM SHALL NOT delete the app's GitHub repo, D1 database, R2 build artifacts, logs, or deployment history.
- **APP-4.3** WHEN the Worker is deleted THE SYSTEM SHALL set `status = 'deleted'` and `deleted_at`, delete the KV route, and delete `app_secrets` metadata rows.
- **APP-4.4** IF `confirm_slug` does not equal the app slug THEN THE SYSTEM SHALL return `INVALID_INPUT` and delete nothing.
- **APP-4.5** WHEN an app is deleted THE SYSTEM SHALL keep its slug reserved (SLUG-3.2) and exclude it from `list_apps`.
- **APP-4.6** IF the Worker script no longer exists in the namespace THEN THE SYSTEM SHALL treat deletion as successful (idempotent).
- **APP-4.7** WHEN deletion is requested while a deployment is in progress THE SYSTEM SHALL mark in-progress deployments `cancelled` and ignore any later artifact upload for them.

### APP-5 — Quotas
As the platform operator, I want per-organization limits, so that free hosting can't be abused.

- **APP-5.1** THE SYSTEM SHALL enforce per-org quotas defined in `limits.ts`: `MAX_APPS_PER_ORG` (active apps), `MAX_DEPLOYS_PER_ORG_PER_DAY`, `MAX_EMAILS_PER_ORG_PER_DAY`.
- **APP-5.2** THE SYSTEM SHALL count daily quotas per UTC day in `usage_counters`, incremented atomically.
- **APP-5.3** WHEN a quota is exceeded THE SYSTEM SHALL return `QUOTA_EXCEEDED` with `details { limit, max, resets_at }` (resets_at omitted for `apps`).
- **APP-5.4** THE SYSTEM SHALL expose current usage and limits via `get_usage()`.

## Non-functional requirements

- `create_app` returns within 30 s in all cases.
- All app lookups are scoped by `org_id` in the SQL query itself, never filtered in memory.

## Out of scope

- Team orgs, invites, roles other than owner, transferring apps between orgs.
- Restoring a deleted app; purging retained resources of deleted apps (see open questions).
- Renaming apps' slugs (display `name` changes: see open questions).
