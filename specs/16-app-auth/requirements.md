# 16 — App User Sign-in: Requirements

Apps built on the platform often have their own users ("several people can use it", or "only I can use it"). Today the AI would have to hand-roll passwords, sessions and reset flows, which is the riskiest code it writes. This spec adds a platform service, the `AUTH` binding, that signs an *app's* users in with an emailed one-time code — the same passwordless flow the platform itself uses (spec 02) — and lets the app owner restrict who may sign in. It is unrelated to the platform's own OAuth login for MCP clients: those are the app owners; these are the owners' customers.

## Stories & acceptance criteria

### UAUTH-1 — Sign in with an emailed code
As an app's user, I want to type my email and a code, so that I can use the app without a password.

- **UAUTH-1.1** WHEN app code calls `env.AUTH.startLogin({ email })` THE SYSTEM SHALL email a 6-digit code (valid `LOGIN_CODE_TTL_MS`) to that address from the app's own sender (`hello@mail.<slug>.APPS_DOMAIN`, spec 11) with the app's name in the subject and body, and return `{ ok: true }`.
- **UAUTH-1.2** THE SYSTEM SHALL normalize emails (trim, lowercase), reject syntactically invalid ones with `invalid_email`, and respond identically (`{ ok: true }`) whether or not the address is registered or allowed (UAUTH-3), so the response never reveals who has an account.
- **UAUTH-1.3** THE SYSTEM SHALL store only an HMAC-SHA256 of each code (keyed with the platform pepper, message `appId:email:code`), invalidate earlier unconsumed codes for the same app and email when a new one is issued, and allow `LOGIN_CODE_MAX_ATTEMPTS` wrong tries per code.
- **UAUTH-1.4** WHEN `env.AUTH.finishLogin({ email, code })` is called with the latest valid code THE SYSTEM SHALL create the user in that app if new, create a session, and return `{ ok: true, user, session: { token, expires_at }, is_new_user }`; wrong or expired codes return `{ ok: false, error: { code: 'code_invalid' | 'code_expired' | 'attempts_exceeded', message } }` (with `attempts_remaining` when applicable).
- **UAUTH-1.5** THE SYSTEM SHALL limit codes to `APP_LOGIN_CODES_PER_EMAIL_PER_HOUR` per email and app, `APP_LOGIN_CODES_PER_APP_PER_DAY` per app, and the org's daily email quota (MAIL-2.6), returning `{ ok: false, error: { code: 'rate_limited', retry_after_seconds } }` without sending.
- **UAUTH-1.6** THE SYSTEM SHALL skip sending to globally suppressed addresses (spec 11) while still returning `{ ok: true }` (UAUTH-1.2), and count every sent code as an email in the app's usage (spec 13, `emails`).
- **UAUTH-1.7** IF the app's sending identity or its org's tenant is not ready (MAIL-2.7) THEN `startLogin` SHALL return `{ ok: false, error: { code: 'email_not_ready' } }`.

### UAUTH-2 — Sessions
As an app, I want to know who is calling, so that I can show them their own data.

- **UAUTH-2.1** THE SYSTEM SHALL return session tokens as random 32-byte URL-safe strings, store only their SHA-256, and never log them.
- **UAUTH-2.2** WHEN `env.AUTH.getUser(token)` is called THE SYSTEM SHALL return `{ id, email, name, created_at }` of the session's user, or `null` for an unknown, expired or revoked token, and SHALL extend the session's expiry (sliding `APP_SESSION_TTL_S`, default 30 days) at most once per `APP_SESSION_TOUCH_INTERVAL_S`.
- **UAUTH-2.3** THE user `id` SHALL be `eu_<nanoid(11)>` (spec 00 id convention), unique across apps and stable for that app's user; apps store it as the foreign key in their own tables.
- **UAUTH-2.4** WHEN `env.AUTH.logout(token)` is called THE SYSTEM SHALL revoke that session; `env.AUTH.logoutEverywhere(userId)` SHALL revoke all of the user's sessions.
- **UAUTH-2.5** THE SYSTEM SHALL keep at most `APP_SESSIONS_PER_USER` active sessions per user, revoking the oldest when a new one is created.
- **UAUTH-2.6** THE SYSTEM SHALL let apps set `env.AUTH.updateUser(userId, { name })` (display name, ≤ `APP_USER_NAME_MAX_CHARS`).
- **UAUTH-2.7** THE SYSTEM SHALL scope every operation to the calling app from the binding's platform-set props (MAIL-2.2 pattern); a token or user id of another app is unknown.

### UAUTH-3 — Who may sign in
As an app owner, I want to keep my app private or open, so that "only me" apps really are only mine.

- **UAUTH-3.1** WHEN `set_auth_policy({ app, mode, allowed_emails?, allowed_domains? })` is called THE SYSTEM SHALL store the policy: `mode: 'open'` (anyone with a working email) or `'allowlist'` (only listed emails or any email at a listed domain). New apps are `open`.
- **UAUTH-3.2** IN `allowlist` mode THE SYSTEM SHALL send no code to other addresses and still return `{ ok: true }` (UAUTH-1.2); `finishLogin` for them fails with `code_invalid`.
- **UAUTH-3.3** THE SYSTEM SHALL cap allowlists at `APP_AUTH_ALLOWLIST_MAX_ENTRIES` entries; entries are validated and normalized like emails (domains without `@`).
- **UAUTH-3.4** WHEN the policy changes from `open` to `allowlist` THE SYSTEM SHALL revoke sessions of users who are no longer allowed.

### UAUTH-4 — Operating the users
As an AI client, I want to see and remove an app's users, so that I can support the owner.

- **UAUTH-4.1** WHEN `list_app_users({ app, cursor? })` is called THE SYSTEM SHALL return up to `MAX_APP_USERS_LISTED` users (`id`, `email`, `name`, `created_at`, `last_login_at`), newest first, a total count, and the policy.
- **UAUTH-4.2** WHEN `delete_app_user({ app, user_id })` is called THE SYSTEM SHALL delete the user, their sessions and pending codes, and return `{ deleted: true }`; deleting an unknown user succeeds (idempotent). The app's own rows referencing the id are the app's to clean up, and the tool's result says so.
- **UAUTH-4.3** THE tools SHALL require a ready app of the caller (`resolveApp`, like `query_database`).
- **UAUTH-4.4** THE SYSTEM SHALL NOT expose end-user emails in tracking events (spec 05): tool arguments containing emails are redacted to hashes.

### UAUTH-5 — Binding and lifecycle
- **UAUTH-5.1** THE SYSTEM SHALL add `AUTH` (a service binding to the platform's `AppAuth` entrypoint with props `{ appId, orgId, slug }`) to every deployed app; `AUTH` becomes a reserved binding name (CON-2.5).
- **UAUTH-5.2** THE guide SHALL document the binding's API, a copy-paste Hono middleware and cookie recipe (`HttpOnly`, `SameSite=Lax`, `Secure`), and how `allowlist` mode serves "only me" apps.
- **UAUTH-5.3** WHEN an app is deleted THE SYSTEM SHALL make every `AUTH` call return `{ ok: false, error: { code: 'app_deleted' } }` (`getUser` → `null`) and SHALL keep its users (APP-4: nothing but the Worker is removed).
- **UAUTH-5.4** THE SYSTEM SHALL purge expired sessions and codes daily.

## Non-functional requirements

- `getUser` p95 < 150 ms (one D1 read); `startLogin` p95 < 1.5 s (SES).
- No end user's email or token appears in logs or metrics; only ids and counts.

## Out of scope

- Passwords, social login, magic links, 2FA, account recovery beyond "get a new code".
- A hosted sign-in page (the AI builds the UI in the app).
- Roles and permissions inside an app (apps model them in their own tables).
- Importing users, custom email templates, custom sender domains.
