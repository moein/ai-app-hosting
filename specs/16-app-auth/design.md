# 16 — App User Sign-in: Design

## Topology

```
app script ──AUTH (service binding, entrypoint AppAuth, props { appId, orgId, slug })──▶ apps/email ──▶ platform D1
                                                                     └─ sends code emails through the same SES path as AppMail (spec 11)
api (MCP tools)  ──▶ platform D1 (set_auth_policy, list_app_users, delete_app_user)
api daily cron   ──▶ purge expired sessions/codes
```

The entrypoint lives in `apps/email` because it already holds the SES client, the per-app sender logic, suppression and quota queries, and the platform D1 binding. The email worker gains the `LOGIN_CODE_PEPPER` secret (same `.env` key as the api; `scripts/set-secrets.mjs` adds it to the email worker).

## Data model (platform D1, migration in `apps/api/migrations`)

```sql
CREATE TABLE app_end_users (
  id            TEXT PRIMARY KEY,                 -- eu_<nanoid(11)>
  app_id        TEXT NOT NULL REFERENCES apps(id),
  email         TEXT NOT NULL,                    -- normalized
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (app_id, email)
);
CREATE INDEX app_end_users_app_created ON app_end_users (app_id, created_at DESC);

CREATE TABLE app_end_sessions (
  token_hash   TEXT PRIMARY KEY,                  -- SHA-256 hex of the token
  user_id      TEXT NOT NULL REFERENCES app_end_users(id),
  app_id       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  touched_at   INTEGER NOT NULL
);
CREATE INDEX app_end_sessions_user ON app_end_sessions (user_id);

CREATE TABLE app_end_login_codes (
  id           TEXT PRIMARY KEY,                  -- lc_… (spec 00)
  app_id       TEXT NOT NULL,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  invalidated_at INTEGER
);
CREATE INDEX app_end_login_codes_lookup ON app_end_login_codes (app_id, email, created_at DESC);

CREATE TABLE app_auth_settings (
  app_id           TEXT PRIMARY KEY REFERENCES apps(id),
  mode             TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'allowlist'
  allowed_emails   TEXT NOT NULL DEFAULT '[]',    -- JSON array
  allowed_domains  TEXT NOT NULL DEFAULT '[]',
  updated_at       INTEGER NOT NULL
);
```

The hash message for codes is `appId:email:code` (`hashLoginCode` gains an `appId` scope argument; the platform's own login keeps its `email:code` form). `newId('eu')` adds the `eu_` prefix to `packages/shared` (CLAUDE.md id conventions).

## Entrypoint (`apps/email/src/app-auth/`)

```ts
export class AppAuth extends WorkerEntrypoint<Env, AppMailProps> {
  startLogin(input: { email: string }): Promise<{ ok: true } | AuthError>;
  finishLogin(input: { email: string; code: string }): Promise<{ ok: true; user: AuthUser; session: { token: string; expires_at: string }; is_new_user: boolean } | AuthError>;
  getUser(token: string): Promise<AuthUser | null>;
  logout(token: string): Promise<{ ok: true }>;
  logoutEverywhere(userId: string): Promise<{ ok: true }>;
  updateUser(userId: string, patch: { name?: string }): Promise<{ ok: true; user: AuthUser } | AuthError>;
}
type AuthUser = { id: string; email: string; name: string | null; created_at: string };
type AuthError = { ok: false; error: { code: 'invalid_email' | 'rate_limited' | 'email_not_ready' | 'code_invalid' | 'code_expired' | 'attempts_exceeded' | 'app_deleted' | 'invalid_input'; message: string; retry_after_seconds?: number; attempts_remaining?: number } };
```

Same conventions as `AppMail`: nothing throws, identity from `this.ctx.props`, every input validated at runtime.

### `startLogin` algorithm

```
validate email → invalid_email
app = D1 apps by props.appId; deleted → app_deleted; app.email_status/tenant not ready → email_not_ready
per-app daily and per-email hourly counts (app_end_login_codes) → rate_limited
policy: allowlist and email not allowed → return { ok: true } (no code, no email)   // UAUTH-3.2, 1.2
suppressed (global or org) → return { ok: true }                                     // UAUTH-1.6
consume org email quota (1) → rate_limited on quota
insert code (invalidate older), send via SES (from hello@mail.<slug>…, subject "<App name> login code: 482913")
send failure → invalidate code, refund quota, { ok: false, error: { code: 'email_not_ready' } }  (retryable)
addAppUsage emails += 1 (spec 13)
```

The message reuses `loginCodeContent` with the app name and a footer saying the code was requested on `<slug>.APPS_DOMAIN`. Timing side channel: the not-allowed and suppressed paths add no artificial delay; the difference (no SES call) is tolerated (documented in Security notes).

### `finishLogin`

Same verify algorithm as spec 02 (single-use conditional consume, attempts counter, constant-time compare), scoped by `appId`; then `INSERT … ON CONFLICT DO NOTHING` the user, create the session (revoking the oldest beyond `APP_SESSIONS_PER_USER`), update `last_login_at`. Allowlist is re-checked so a removed address can't finish an old code.

### `getUser`

`SELECT u.* FROM app_end_sessions s JOIN app_end_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.app_id = ? AND s.expires_at > ?`; when `now - touched_at > APP_SESSION_TOUCH_INTERVAL_S` a follow-up `UPDATE` slides the expiry (fire-and-forget within the call; failure is ignored).

## MCP tools (`apps/api/src/tools/auth/`)

```
set_auth_policy   in { app; mode: 'open'|'allowlist'; allowed_emails?: string[]; allowed_domains?: string[] }
                  out { mode; allowed_emails; allowed_domains; revoked_sessions: number; next_step }
list_app_users    in { app; cursor?: string }   out { users: {...}[]; total: number; cursor: string|null; policy: { mode } }
delete_app_user   in { app; user_id }           out { deleted: true; next_step: "Also delete rows that reference this id in the app's own tables (query_database)." }
```

Annotations: `set_auth_policy` `{ idempotent }` (not destructive: changing access is reversible), `list_app_users` `{ readOnly, idempotent }`, `delete_app_user` `{ destructive, idempotent }`. Titles and catalog entries per spec 04. Redaction (spec 05): `allowed_emails` entries and `list_app_users` need no redactor for outputs (events record args only); `set_auth_policy.allowed_emails` → replaced by `[<count>]` hashes, `delete_app_user.user_id` kept (an id, not PII).

## Contract and bindings

- `buildBindings` adds `{ type: 'service', name: 'AUTH', service: 'email-<env>', entrypoint: 'AppAuth', props }`.
- `RESERVED_BINDINGS` gains `'AUTH'` (validator).
- New guide topic `auth` (`guide/auth.md`, order after `storage`), `contract.md` bindings list gains `AUTH`.
- The fixture app gets `POST /api/login/start`, `/api/login/finish`, `GET /api/me` (spec 12 e2e).

### Guide recipe (abridged, the source of truth is `guide/auth.md`)

```ts
const SESSION = 'session';
app.post('/api/login/start', async (c) => c.json(await c.env.AUTH.startLogin({ email: (await c.req.json()).email })));
app.post('/api/login/finish', async (c) => {
  const { email, code } = await c.req.json();
  const result = await c.env.AUTH.finishLogin({ email, code });
  if (!result.ok) return c.json(result, 400);
  setCookie(c, SESSION, result.session.token, { httpOnly: true, sameSite: 'Lax', secure: true, path: '/', maxAge: 60 * 60 * 24 * 30 });
  return c.json({ user: result.user });
});
const requireUser = createMiddleware(async (c, next) => {
  const user = await c.env.AUTH.getUser(getCookie(c, SESSION) ?? '');
  if (!user) return c.json({ error: 'sign in first' }, 401);
  c.set('user', user); await next();
});
```

## Usage and limits

`emails` (spec 13) already counts code emails. The D1 rows are platform data (not per-app D1), so end-user storage is not metered separately; row counts are bounded by the org's email quota (300/day) and `MAX_APP_USERS_LISTED` pagination.

| Constant | Value |
|---|---|
| `APP_LOGIN_CODES_PER_EMAIL_PER_HOUR` | 5 |
| `APP_LOGIN_CODES_PER_APP_PER_DAY` | 200 |
| `APP_SESSION_TTL_S` | 30 days |
| `APP_SESSION_TOUCH_INTERVAL_S` | 1 hour |
| `APP_SESSIONS_PER_USER` | 10 |
| `APP_AUTH_ALLOWLIST_MAX_ENTRIES` | 200 |
| `APP_USER_NAME_MAX_CHARS` | 100 |
| `MAX_APP_USERS_LISTED` | 100 |

## Security notes

- **Enumeration:** identical `startLogin` responses; allowlisted-out and suppressed addresses differ only in timing (no SES call). Accepted for v1; noted for later hardening (constant-time padding).
- **Abuse as an email relay:** the recipient is chosen by the app's visitor, but the content is fixed (platform template), volume is capped per email, per app and per org, and suppression applies. An app can't put text of its choice in these emails.
- **Sessions:** tokens are bearer secrets kept in the app's `HttpOnly` cookie; the platform's cookie isolation (spec 09 RUN-5) applies. A leaked D1 read yields only hashes.
- **Cross-app isolation:** every query is scoped by `app_id` from props; user ids are globally unique so a mistaken cross-app id is simply unknown.

## Open questions

1. Email template customization (logo, wording) for apps.
2. Should `getUser` results be cached in the isolate for a few seconds to spare D1 reads?
3. Per-user API tokens for programmatic access.
