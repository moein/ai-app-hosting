# 02 — Identity & Auth: Design

## Flow

```
User            AI client                         apps/api (/mcp)                McpSession DO     D1            PlatformMail
 │ "host my app"   │                                    │                               │            │                  │
 │                 │── whoami ─────────────────────────▶│── read binding ──────────────▶│            │                  │
 │                 │◀─ {authenticated:false, next_step} │                               │            │                  │
 │◀─ "your email?" │                                    │                               │            │                  │
 │── a@b.com ─────▶│── request_login_code(a@b.com) ────▶│── per-session limit ─────────▶│            │                  │
 │                 │                                    │── per-email limits ──────────────────────▶│                  │
 │                 │                                    │── invalidate old, insert code hash ──────▶│                  │
 │                 │                                    │── sendLoginCode ─────────────────────────────────────────────▶│── Resend
 │                 │◀─ {sent:true, expires_in:600}      │                               │            │                  │
 │◀─ "code?"       │                                    │                               │            │                  │
 │── 482913 ──────▶│── verify_login_code(a@b.com,…) ───▶│── load latest code, compare ─────────────▶│                  │
 │                 │                                    │   (new user → batch: user+org+membership)  │                  │
 │                 │                                    │── enqueue org.provision_email_tenant (EMAIL_JOBS)            │
 │                 │                                    │── bind {userId, orgId} ──────▶│            │                  │
 │                 │◀─ {authenticated:true, is_new_user}│                               │            │                  │
```

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

Organizations/memberships tables: spec 03.

## Limits (`packages/shared/limits.ts`)

| Constant | Value |
|---|---|
| `LOGIN_CODE_TTL_MS` | 600_000 |
| `LOGIN_CODE_MAX_ATTEMPTS` | 5 |
| `LOGIN_CODES_PER_EMAIL_PER_HOUR` | 5 |
| `LOGIN_CODES_PER_EMAIL_PER_DAY` | 20 |
| `LOGIN_CODES_PER_SESSION_PER_10_MIN` | 3 |
| `SESSION_IDLE_TTL_MS` | 30 days |

## MCP session Durable Object

`McpSession extends McpAgent` (agents SDK). One instance per `Mcp-Session-Id`. Stored state:

```ts
type SessionState = {
  auth: { userId: UserId; orgId: OrgId; authenticatedAt: number; lastSeenAt: number } | null;
  client: { name: string; version: string } | null;   // from MCP initialize (spec 05)
  loginCodeRequests: number[];                         // epoch ms of recent request_login_code sends; entries
                                                       // older than 10 min are dropped on each call
};
```

Per-session login-code limit (AUTH-1.6): `request_login_code` drops timestamps older than 10 minutes from `loginCodeRequests`; if `LOGIN_CODES_PER_SESSION_PER_10_MIN` remain → `RATE_LIMITED` with `retry_after_seconds` = time until the oldest one expires; otherwise it runs the per-email checks (D1), inserts the code, sends it via `PlatformMail` (Resend, spec 11), and appends `now`. Only sends that actually happened are recorded; if sending fails the new code row is invalidated (AUTH-1.9).

Auth guard (wraps every tool, spec 04):

```
if tool ∈ PUBLIC_TOOLS: run
elif auth == null or now - auth.lastSeenAt > SESSION_IDLE_TTL_MS: clear auth; AUTH_REQUIRED
else:
  user = D1 users by id   (cheap PK lookup; enforces AUTH-3.7)
  if user.status == 'blocked': clear auth; ACCOUNT_BLOCKED
  auth.lastSeenAt = now; run tool with ctx { userId, orgId }
```

`PUBLIC_TOOLS = ['request_login_code', 'verify_login_code', 'whoami', 'get_platform_guide']`.

## Tool contracts

```ts
// request_login_code
in:  { email: string }                                  // z.string().trim().toLowerCase().email().max(254)
out: { sent: true; email: string; expires_in_seconds: 600;
       next_step: "Ask the user for the 6-digit code we just emailed to <email>, then call verify_login_code." }

// verify_login_code
in:  { email: string; code: string }                    // code: strip [\s-], then /^\d{6}$/
out: { authenticated: true; email: string; is_new_user: boolean;
       next_step: "Call get_platform_guide before writing any code, then create_app." }

// logout
in:  {}   out: { authenticated: false }

// whoami
in:  {}
out: { authenticated: true; email: string; member_since: string /* ISO */ }
   | { authenticated: false; next_step: "Ask the user for their email address, then call request_login_code." }
```

Organizations never appear in these outputs (MCP-1.5).

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
bind session
```

The conditional `UPDATE … WHERE consumed_at IS NULL` makes consumption single-use under concurrency. Org slug collisions inside the batch are retried per SLUG-3.3.

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `CODE_INVALID` | false | The code is wrong. Ask the user to re-check the latest email (`details.attempts_remaining` left). If 0, call `request_login_code` again. |
| `CODE_EXPIRED` | false | The code expired. Call `request_login_code` again and ask the user for the new code. |
| `CODE_ATTEMPTS_EXCEEDED` | false | Too many wrong tries. Call `request_login_code` to send a new code. |
| `EMAIL_UNDELIVERABLE` | false | We can't deliver to this address (it bounced or reported spam before). Ask the user for a different email. |
| `ACCOUNT_BLOCKED` | false | This account is blocked. Tell the user to contact support. |

## Tracking

Every tool call is tracked by spec 05 middleware (the `code` argument is always redacted). Additional Analytics Engine events: `login_code_requested`, `login_succeeded` (blob: `signup`|`signin`), `login_failed` (blob: error code).

## Security notes

- **Brute force:** 5 attempts/code × 5 codes/hour/email ⇒ ≤ 25 guesses/hour against 10^6 codes.
- **Enumeration:** identical `request_login_code` responses (AUTH-1.3). `is_new_user` is only revealed after proving control of the mailbox.
- **Phishing by a third party's AI:** mitigated by email copy (AUTH-1.8) and short TTL; the attacker still needs the victim to hand over the code.
- **Code exposure in chat transcripts:** acceptable — single-use, 10-minute TTL, bound to the requesting email.
- **Session possession:** `Mcp-Session-Id` is a server-generated random value held by the AI client; anyone holding it acts as the user. Not returned in tool output and not logged in events (spec 05).

## Open questions

1. **Re-login per MCP session.** A client opening a new MCP session (often: a new chat) must log in again. Options later: (a) add OAuth 2.1 for clients that support it; (b) a "remember this client" mechanism. Decide after observing real usage.
2. Should `verify_login_code` accept the code only from the MCP session that requested it (stronger phishing protection, worse UX if the client reconnects mid-flow)? Current design: any session. Adopting it would mean adding a `session_id` column (no index needed — the lookup is already by email).
3. Email copy and localization.
