# 02 — Identity & Auth: Tasks

Depends on: 00 (tasks 1–7), 01 (tasks 1–3), 04 (task 1–2: McpSession + tool framework), 11 (task 3: `PlatformMail.sendLoginCode`; a fake is enough to start).

- [x] **1. Schema: `users`, `login_codes`, `organizations`, `memberships`, `email_suppressions`** (+ migration)
  Satisfies: FND-6.1 (for these tables)
  Tests: migration applies; unique email enforced.

- [x] **2. Code generation + hashing helpers**
  Uniform 6-digit generator; `hashCode(pepper, email, code)`; constant-time compare; email normalizer.
  Satisfies: AUTH-1.2, AUTH-1.4, AUTH-2.2
  Tests: distribution sanity (no modulo bias path), leading zeros preserved, normalization cases, code stripping (`"482 913"`, `"482-913"`).

- [x] **3. `request_login_code` tool**
  Rate-limit queries, suppression check, invalidate previous, insert, send via `MAIL.sendLoginCode`.
  Satisfies: AUTH-1.1, AUTH-1.3, AUTH-1.5, AUTH-1.6, AUTH-1.7, AUTH-1.8, AUTH-1.9
  Tests (pool-workers, fake mail): happy path stores hash not code; identical response for known/unknown email; previous code invalidated; each rate limit boundary (5th ok/6th limited etc.) with `retry_after_seconds`; per-session limit enforced from `McpSession` state (4th request in 10 min limited, allowed again after the oldest expires — fake clock) and unaffected by requests from other sessions; `login_codes` has no `session_id` column; suppressed email → `EMAIL_UNDELIVERABLE` and no send; mail failure → `UPSTREAM_ERROR`, code invalidated, session count unchanged; email body contains code + warning text.

- [x] **4. `verify_login_code` tool**
  Satisfies: AUTH-2.1, AUTH-2.3, AUTH-2.5, AUTH-2.6, AUTH-2.7, AUTH-2.8, AUTH-2.9, AUTH-2.10
  Tests: success binds session; wrong code decrements `attempts_remaining`; 5th wrong → `CODE_ATTEMPTS_EXCEEDED` and code unusable; expired; no code; concurrent double-verify consumes once; existing user updates `last_login_at`; switching users in one session; blocked user.

- [x] **5. Signup provisioning**
  Atomic batch user + org + membership; enqueue `org.provision_email_tenant`.
  Satisfies: AUTH-2.4, SLUG-2.7
  Tests: new email creates exactly one user/org/membership with role `owner`; org slug from email local part; batch failure leaves no partial rows; job message enqueued with org id.

- [x] **6. Auth guard, `whoami`, `logout`, sliding expiry**
  Satisfies: AUTH-3.1, AUTH-3.2, AUTH-3.3, AUTH-3.4, AUTH-3.5, AUTH-3.6, AUTH-3.7
  Tests: public tools work unauthenticated; a protected tool returns `AUTH_REQUIRED` with hint; binding expires after 30 days idle (fake clock) and is refreshed by use; logout clears; blocked user rejected and unbound; no tool output contains the session id (snapshot scan).

- [x] **7. Purge cron for old `login_codes`**
  Satisfies: (hygiene; design.md)
  Tests: rows older than 7 days removed, newer kept.

- [x] **8. Auth metrics** (after spec 05 task for AE writer)
  Satisfies: EVT-2.2 (auth events)
  Tests: AE writer fake receives `login_code_requested`, `login_succeeded` (signup/signin), `login_failed`.

- [x] **9. E2E on dev** (spec 12)
  Flows: `F-AUTH-1`, `F-AUTH-2`, `F-AUTH-3`, `F-AUTH-4`, `F-AUTH-5`.
  Satisfies: E2E-3.3

- [x] **10. OAuth provider in front of the api** (`@cloudflare/workers-oauth-provider`, `OAUTH_KV`, metadata, DCR + CIMD)
  Satisfies: AUTH-4.1, AUTH-4.2, AUTH-4.3, AUTH-4.5, AUTH-4.6
  Tests: `/mcp` without token → 401 with `resource_metadata`; both metadata documents; register → authorize → token → MCP call works; wrong verifier / redirect rejected; refresh rotates.

- [x] **11. Sign-in pages + login-code service**
  Satisfies: AUTH-1.*, AUTH-2.*, AUTH-4.4, AUTH-4.8
  Tests: every AUTH-1/2 rule through the pages (rate limits incl. per-sign-in and per-IP, suppression, send failure, wrong/expired/exhausted code, signup vs signin, blocked); client name + redirect host shown; foreign `Origin` → 403; unknown/expired pending → error page; `completeAuthorization` props; no-store + CSP headers.

- [x] **12. MCP identity from token props; remove login tools**
  Satisfies: AUTH-3.6, AUTH-4.7
  Tests: tools see `userId`/`orgId` from props; blocked user → `ACCOUNT_BLOCKED`; `whoami` shape; catalog no longer has the login tools; tracking carries the user.

- [ ] **13. E2E on dev** (spec 12) — harness signs in through OAuth (register, authorize page, emailed code, token).
  Flows: `F-AUTH-1`…`F-AUTH-5` (updated), `F-MCP-1`…`F-MCP-3`.
  Satisfies: E2E-3.3
