# 02 — Identity & Auth: Design

## Flow

```
User          AI client (e.g. Claude)                       apps/api                                         D1 / KV / PlatformMail
 │ adds connector │── POST /mcp (no token) ───────────────────▶│ 401 WWW-Authenticate: resource_metadata=…     │
 │                │── GET /.well-known/oauth-protected-resource ▶ { resource: …/mcp, authorization_servers }  │
 │                │── GET /.well-known/oauth-authorization-server ▶ endpoints, S256, registration              │
 │                │── POST /oauth/register (DCR) or CIMD client id ▶ client                                    │
 │◀── browser ────│── GET /authorize?client_id&redirect_uri&code_challenge&state&resource&scope               │
 │── email ──────────────────────────────────────────────────▶ POST /authorize/email ── code → Resend ─────────▶│
 │── 482913 ─────────────────────────────────────────────────▶ POST /authorize/code  ── verify, signup? ───────▶│
 │                │◀─ 302 redirect_uri?code&state ────────────│ completeAuthorization(props {userId,orgId,email})│
 │                │── POST /oauth/token (code + verifier) ────▶ access + refresh token                           │
 │                │── POST /mcp  Authorization: Bearer … ─────▶ McpSession (this.props = identity)             │
```

`apps/api` default export is `OAuthProvider` from `@cloudflare/workers-oauth-provider` (after env validation):

```ts
new OAuthProvider({
  apiRoute: '/mcp', apiHandler: McpSession.serve('/mcp', { binding: 'MCP_SESSION' }),
  defaultHandler: honoApp,                       // /healthz, /v1/*, /authorize pages
  authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['apps'], accessTokenTTL: OAUTH_ACCESS_TOKEN_TTL_S, refreshTokenTTL: OAUTH_REFRESH_TOKEN_TTL_S,
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: `${PLATFORM_API_ORIGIN}/mcp`, authorization_servers: [PLATFORM_API_ORIGIN] },
})
```

It stores clients, grants and token hashes in the `OAUTH_KV` namespace (props encrypted with the token, AUTH-4.6).

## Sign-in page (`src/http/routes/authorize.ts`, server-rendered HTML, no JavaScript)

| Request | Behaviour |
|---|---|
| `GET /authorize?…` | `parseAuthRequest` + `lookupClient` (invalid → error page, no redirect). Stores a *pending sign-in* `{ oauthReq, clientName, redirectHost, codesSent: 0 }` in `OAUTH_KV` under `pending:<random 32 bytes>` with TTL `OAUTH_PENDING_TTL_S`; renders the email form with the pending id in a hidden field and "<client> wants to use your AI App Hosting account (returns to <host>)". |
| `POST /authorize/email` | Origin check (AUTH-4.8); per-IP limit; load pending; per-sign-in and per-email limits; suppression; issue code (hash, invalidate older), send via `PlatformMail`; save email + `codesSent` on the pending record; render the code form. |
| `POST /authorize/code` | Origin check; load pending (must have an email); verify (algorithm below); signup or `last_login_at`; `completeAuthorization({ request: oauthReq, userId, scope, metadata: { label: email }, props: { userId, orgId, email } })`; delete the pending record; `302` to the returned `redirectTo`. |
| `POST /authorize/resend`, `POST /authorize/restart` | Resend a code to the same email (limits apply) / back to the email form. |

Pages share the website's look (inline CSS), send `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`, and `Cache-Control: no-store`. No `form-action`: some browsers' CSP matching for it is unreliable even naming the exact origin (seen with a Thorium build), and it would only be defense-in-depth here — no `script-src` is allowed at all, so no script can run on these pages regardless. Errors are shown in plain language on the same form.

The login-code service (`src/auth/login-codes.ts`: `issueLoginCode`, `verifyLoginCode`) holds the rules of AUTH-1/AUTH-2 and is used only by these pages.

## MCP identity

`McpSession` reads `this.props` (`{ userId, orgId, email }`) set by the provider. The auth guard (every tool, spec 04):

```
props missing                     → AUTH_REQUIRED (can't happen behind the provider; defensive)
user = D1 users by id             (PK lookup; AUTH-4.7)
missing → AUTH_REQUIRED; blocked → ACCOUNT_BLOCKED
ctx.userId / ctx.orgId / ctx.email = props
```

Tools `request_login_code`, `verify_login_code` and `logout` no longer exist; `whoami` returns `{ email, member_since }`. Disconnecting is done in the AI client (it drops the tokens).

## Data model (platform D1)

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,               -- usr_…
  email          TEXT NOT NULL UNIQUE,           -- normalized
  status         TEXT NOT NULL DEFAULT 'active', -- 'active' | 'blocked'
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE login_codes (
  id              TEXT PRIMARY KEY,              -- lc_…
  email           TEXT NOT NULL,                 -- normalized
  code_hash       TEXT NOT NULL,                 -- hex HMAC-SHA256(pepper, email:code)
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  invalidated_at  INTEGER
);
CREATE INDEX login_codes_email ON login_codes (email);
```

A single-column index is enough: the rate limits (AUTH-1.6) and the 7-day purge keep rows per email at most ~140 (20/day × 7), so filtering the remaining `created_at` range in that handful of rows is trivial. The purge cron scans the table once a day without an index.

The per-session limit is not stored in D1 at all — it lives in the `McpSession` Durable Object (below), which already exists per session and is single-threaded, so its count is exact without any table or index.

"Active code" = latest row for the email with `consumed_at IS NULL AND invalidated_at IS NULL`. Rows older than 7 days are purged by a daily cron (`scheduled` handler in `apps/api`).

Organizations/memberships tables are owned by spec 03 but created in the same migration as `users` because signup needs them; `email_suppressions` (spec 11) is created there too because AUTH-1.7 reads it.

## Limits (`packages/shared/limits.ts`)

| Constant | Value |
|---|---|
| `LOGIN_CODE_TTL_MS` | 600_000 |
| `LOGIN_CODE_MAX_ATTEMPTS` | 5 |
| `LOGIN_CODES_PER_EMAIL_PER_HOUR` | 5 |
| `LOGIN_CODES_PER_EMAIL_PER_DAY` | 20 |
| `LOGIN_CODES_PER_SESSION_PER_10_MIN` | 3 |
| `SESSION_IDLE_TTL_MS` | 30 days |

## Verify algorithm

```
code = strip(code); row = active code for email
if !row:                         CODE_INVALID {attempts_remaining: 0}
if row.expires_at <= now:        CODE_EXPIRED
ok = timingSafeEqual(hmac(email:code), row.code_hash)
if !ok:
  attempts = row.attempts + 1  (UPDATE … SET attempts = attempts + 1 WHERE id=? AND consumed_at IS NULL RETURNING attempts)
  if attempts >= 5: set invalidated_at; CODE_ATTEMPTS_EXCEEDED
  else CODE_INVALID {attempts_remaining: 5 - attempts}
consume: UPDATE … SET consumed_at=now WHERE id=? AND consumed_at IS NULL  → 0 rows ⇒ CODE_INVALID (lost race)
user = by email
if !user: D1 batch [INSERT users, INSERT organizations (slug via generateSlug), INSERT memberships]; enqueue job
elif user.status == 'blocked': ACCOUNT_BLOCKED
else: UPDATE last_login_at
complete the OAuth authorization (props = identity)
```

The conditional `UPDATE … WHERE consumed_at IS NULL` makes consumption single-use under concurrency. Org slug collisions inside the batch are retried per SLUG-3.3.

## Mail and secrets

- The api calls the email worker's `PlatformMail.sendLoginCode({ to, code, codeId })` over the `MAIL` service binding and rethrows a failed result as a `PlatformError` (spec 11). The sign-in routes receive it through their deps, so tests inject a fake.
- `LOGIN_CODE_PEPPER` is a per-environment api secret, generated by `pnpm secrets:<env>` into `.env.<env>` as `LOGIN_CODE_PEPPER` (each environment has its own file, hence its own value). Rotating it invalidates outstanding codes only.

## Error codes

`ACCOUNT_BLOCKED` (retryable false): "This account is blocked. Tell the user to contact support." `AUTH_REQUIRED` stays for defensive use. The sign-in page shows plain-language messages instead of codes: wrong code (attempts left), expired, too many attempts, undeliverable address, couldn't send.

## Tracking

The sign-in routes write the Analytics Engine events `login_code_requested`, `login_succeeded` (sub `signup`|`signin`, with the client name) and `login_failed` (sub = reason). Tool calls are tracked by spec 05; their events carry the user from the token.

## Security notes

- **Brute force:** 5 attempts/code × 5 codes/hour/email ⇒ ≤ 25 guesses/hour against 10^6 codes; plus the per-IP limit.
- **Enumeration:** identical responses for known and unknown emails (AUTH-1.3).
- **Confused deputy / phishing by a malicious client:** the page names the requesting client and its redirect host before any code is sent (AUTH-4.4); PKCE and exact redirect-URI matching are enforced by the provider.
- **CSRF on the sign-in forms:** `Origin` (or `Referer` when a browser omits `Origin`, e.g. Thorium) must be `PLATFORM_API_ORIGIN`, and every post references an unguessable pending id bound to one authorization request (AUTH-4.8).
- **Token theft:** only hashes are stored; access tokens are short-lived; refresh tokens rotate.

## Open questions

1. **Re-login per MCP session.** A client opening a new MCP session (often: a new chat) must log in again. Options later: (a) add OAuth 2.1 for clients that support it; (b) a "remember this client" mechanism. Decide after observing real usage.
2. Should `verify_login_code` accept the code only from the MCP session that requested it (stronger phishing protection, worse UX if the client reconnects mid-flow)? Current design: any session. Adopting it would mean adding a `session_id` column (no index needed — the lookup is already by email).
3. Email copy and localization.
