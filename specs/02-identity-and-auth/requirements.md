# 02 — Identity & Auth: Requirements

The MCP server is an OAuth 2.1 protected resource with its own authorization server (MCP authorization spec). When a person adds the platform to their AI client, the client discovers the authorization server, registers itself, and opens our sign-in page. There the person enters their email and the 6-digit code we email them; the same flow covers signup and signin. The client then calls `/mcp` with a bearer token. No password, and nothing to paste into the chat.

(Before 2026-09-28 sign-in happened inside the chat through `request_login_code` / `verify_login_code` tools. Those tools and the per-session binding were removed; the code issuing and checking rules below are unchanged, only their entry point moved to the sign-in page.)

## Stories & acceptance criteria

### AUTH-1 — Request a login code (sign-in page)
As a non-technical user, I want to just type my email, so that I can get started without creating a password.

- **AUTH-1.1** WHEN a valid email is submitted on the sign-in page THE SYSTEM SHALL email a 6-digit numeric code to that address and show the code form (with the email and a way to change it or resend).
- **AUTH-1.2** THE SYSTEM SHALL normalize emails by trimming whitespace and lowercasing before any lookup or storage; IF the email is syntactically invalid THEN THE SYSTEM SHALL show an error on the email form.
- **AUTH-1.3** THE SYSTEM SHALL respond identically for registered and unregistered emails.
- **AUTH-1.4** THE SYSTEM SHALL store only an HMAC-SHA256 of the code (keyed with `LOGIN_CODE_PEPPER`, message `email:code`), never the code itself, with an expiry of 10 minutes.
- **AUTH-1.5** WHEN a new code is issued for an email THE SYSTEM SHALL invalidate all previously issued, unconsumed codes for that email.
- **AUTH-1.6** IF more than 5 codes were requested for the same email in the past hour, or more than 20 in the past 24 hours, or more than `LOGIN_CODES_PER_SIGN_IN` for the same sign-in attempt, or the client IP exceeds `LOGIN_PAGE_REQUESTS_PER_MINUTE` (30 — many people share an IP, so this only stops floods; the per-email limits bound email volume) THEN THE SYSTEM SHALL show a "too many attempts, try again in N minutes" message and SHALL NOT send an email.
- **AUTH-1.7** IF the email is on the global suppression list (hard bounce, spec 11) THEN THE SYSTEM SHALL ask for a different email and SHALL NOT send an email.
- **AUTH-1.8** THE SYSTEM SHALL send login-code emails whose body contains the code, its validity period, and a warning to enter it only on the platform's sign-in page they opened themselves, and to ignore the email otherwise.
- **AUTH-1.9** IF sending the email fails THEN THE SYSTEM SHALL invalidate the just-created code, show a "couldn't send, try again" message, and SHALL NOT count the request toward the per-sign-in limit.

### AUTH-2 — Verify the code (sign up or sign in)
As a user, I want to type the code I received, so that my AI can act on my behalf.

- **AUTH-2.1** WHEN the latest unconsumed, unexpired code for the email is submitted THE SYSTEM SHALL mark the code consumed, complete the OAuth authorization for the requesting client, and redirect back to the client.
- **AUTH-2.2** THE SYSTEM SHALL strip spaces and hyphens from the submitted code before verification and compare hashes in constant time.
- **AUTH-2.3** IF the code does not match THEN THE SYSTEM SHALL increment the code's attempt counter and show how many attempts remain.
- **AUTH-2.4** WHEN verification succeeds for an email with no user THE SYSTEM SHALL, in a single atomic D1 batch, create the user, a personal organization (slug per SLUG-2.7), and an `owner` membership, and SHALL then enqueue an `org.provision_email_tenant` job (spec 11).
- **AUTH-2.5** IF the latest code for the email has expired THEN THE SYSTEM SHALL say so and offer to send a new one.
- **AUTH-2.6** IF there is no active code for the email THEN THE SYSTEM SHALL say the code is invalid and offer to send a new one.
- **AUTH-2.7** WHEN a code reaches 5 failed attempts THE SYSTEM SHALL invalidate it and offer to send a new one.
- **AUTH-2.8** WHEN an existing user verifies successfully THE SYSTEM SHALL update `users.last_login_at`.
- **AUTH-2.10** IF the user's status is `blocked` THEN THE SYSTEM SHALL show that the account is blocked and SHALL NOT complete the authorization.

### AUTH-4 — OAuth for MCP clients
As an AI client, I want standard MCP authorization, so that I can connect without custom setup.

- **AUTH-4.1** WHEN `/mcp` is called without a valid bearer token THE SYSTEM SHALL answer `401` with `WWW-Authenticate: Bearer resource_metadata="<PLATFORM_API_ORIGIN>/.well-known/oauth-protected-resource"`.
- **AUTH-4.2** THE SYSTEM SHALL publish OAuth 2.0 Protected Resource Metadata (RFC 9728, resource `PLATFORM_API_ORIGIN/mcp`) and Authorization Server Metadata (RFC 8414).
- **AUTH-4.3** THE SYSTEM SHALL support Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents, the authorization code grant with PKCE S256 only (no implicit grant), resource indicators (RFC 8707), and refresh tokens.
- **AUTH-4.4** THE sign-in page SHALL show which client is asking (its name and redirect host) before sending a code.
- **AUTH-4.5** THE SYSTEM SHALL issue access tokens valid for `OAUTH_ACCESS_TOKEN_TTL_S` and refresh tokens valid for `OAUTH_REFRESH_TOKEN_TTL_S`, rotated on use (so an active connection stays signed in; one unused for 30 days has to sign in again).
- **AUTH-4.6** THE SYSTEM SHALL store only hashes of tokens and codes; the token's identity (`userId`, `orgId`, `email`) is encrypted at rest.
- **AUTH-4.7** WHEN an authenticated MCP call arrives THE SYSTEM SHALL take the user from the token, and IF the user no longer exists or is `blocked` THEN every tool SHALL return `ACCOUNT_BLOCKED` (or `AUTH_REQUIRED` for a missing user).
- **AUTH-4.8** THE sign-in form posts SHALL be accepted only from the platform's own origin (`Origin` check, falling back to `Referer` when `Origin` is absent — some browsers omit it on a same-origin top-level form post) and only for a pending authorization created by `/authorize` within the last `OAUTH_PENDING_TTL_S`.

### AUTH-3 — Identity in tools
- **AUTH-3.6** WHEN `whoami` is called THE SYSTEM SHALL return `{ email, member_since }` of the signed-in user.

## Non-functional requirements

- Sending a code p95 < 1.5 s (dominated by the Resend call).
- Login codes use `crypto.getRandomValues` with rejection sampling (uniform 000000–999999).
- Per-email rate limits count rows in D1 (`login_codes`); the per-sign-in limit is kept with the pending authorization; the per-IP limit uses a Workers rate-limiting binding.
- The sign-in page works on phones, needs no JavaScript, and has no third-party resources.

## Out of scope

- Passwords, social login, 2FA, API keys.
- Account deletion and email change (later spec).
- Listing and revoking connected clients from a web page (later).
