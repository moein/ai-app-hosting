# 02 — Identity & Auth: Requirements

Users sign up and sign in entirely through MCP tools. The AI asks the user for their email, calls `request_login_code`, asks the user for the 6-digit code they received, and calls `verify_login_code`. The same flow covers signup and signin. There is no OAuth and no web page.

## Stories & acceptance criteria

### AUTH-1 — Request a login code
As a non-technical user, I want to just tell the AI my email, so that I can get started without creating a password.

- **AUTH-1.1** WHEN `request_login_code({ email })` is called with a valid email THE SYSTEM SHALL email a 6-digit numeric code to that address and return `{ sent: true, email, expires_in_seconds: 600, next_step }`.
- **AUTH-1.2** THE SYSTEM SHALL normalize emails by trimming whitespace and lowercasing before any lookup or storage; IF the email is syntactically invalid THEN THE SYSTEM SHALL return `INVALID_INPUT`.
- **AUTH-1.3** THE SYSTEM SHALL return the same response shape and content for registered and unregistered emails.
- **AUTH-1.4** THE SYSTEM SHALL store only an HMAC-SHA256 of the code (keyed with `LOGIN_CODE_PEPPER`, message `email:code`), never the code itself, with an expiry of 10 minutes.
- **AUTH-1.5** WHEN a new code is issued for an email THE SYSTEM SHALL invalidate all previously issued, unconsumed codes for that email.
- **AUTH-1.6** IF more than 5 codes were requested for the same email in the past hour, or more than 20 in the past 24 hours, or more than 3 from the same MCP session in the past 10 minutes THEN THE SYSTEM SHALL return `RATE_LIMITED` with `details.retry_after_seconds` and SHALL NOT send an email.
- **AUTH-1.7** IF the email is on the global suppression list (hard bounce, spec 11) THEN THE SYSTEM SHALL return `EMAIL_UNDELIVERABLE` and SHALL NOT send an email.
- **AUTH-1.8** THE SYSTEM SHALL send login-code emails whose body contains the code, its validity period, and a warning to share the code only with an AI chat the recipient started themselves and to ignore the email otherwise.
- **AUTH-1.9** IF sending the email fails THEN THE SYSTEM SHALL invalidate the just-created code and return the mail error (`UPSTREAM_ERROR`, retryable), and SHALL NOT count the request toward the per-session limit.

### AUTH-2 — Verify the code (sign up or sign in)
As a user, I want to give the AI the code I received, so that it can act on my behalf.

- **AUTH-2.1** WHEN `verify_login_code({ email, code })` is called with the latest unconsumed, unexpired code for that email THE SYSTEM SHALL mark the code consumed, bind the user to the current MCP session, and return `{ authenticated: true, email, is_new_user, next_step }`.
- **AUTH-2.2** THE SYSTEM SHALL strip spaces and hyphens from the submitted code before verification and compare hashes in constant time.
- **AUTH-2.3** IF the code does not match THEN THE SYSTEM SHALL increment the code's attempt counter and return `CODE_INVALID` with `details.attempts_remaining`.
- **AUTH-2.4** WHEN verification succeeds for an email with no user THE SYSTEM SHALL, in a single atomic D1 batch, create the user, a personal organization (slug per SLUG-2.7), and an `owner` membership, and SHALL then enqueue an `org.provision_email_tenant` job (spec 11).
- **AUTH-2.5** IF the latest code for the email has expired THEN THE SYSTEM SHALL return `CODE_EXPIRED`.
- **AUTH-2.6** IF there is no active code for the email THEN THE SYSTEM SHALL return `CODE_INVALID` with `details.attempts_remaining: 0`.
- **AUTH-2.7** WHEN a code reaches 5 failed attempts THE SYSTEM SHALL invalidate it and return `CODE_ATTEMPTS_EXCEEDED`.
- **AUTH-2.8** WHEN an existing user verifies successfully THE SYSTEM SHALL update `users.last_login_at`.
- **AUTH-2.9** WHEN verification succeeds in a session already bound to a different user THE SYSTEM SHALL replace the binding with the new user.
- **AUTH-2.10** IF the user's status is `blocked` THEN THE SYSTEM SHALL return `ACCOUNT_BLOCKED` and SHALL NOT bind the session.

### AUTH-3 — Session binding
As a user, I want to stay logged in during my conversation, so that the AI doesn't keep asking me for codes.

- **AUTH-3.1** THE SYSTEM SHALL store the authenticated user and their personal org ID in the MCP session's Durable Object and SHALL NOT return any session token or credential in tool results.
- **AUTH-3.2** THE SYSTEM SHALL expire a session binding 30 days after the last authenticated tool call (sliding), after which tools SHALL return `AUTH_REQUIRED`.
- **AUTH-3.3** THE SYSTEM SHALL allow exactly these tools without an authenticated session: `request_login_code`, `verify_login_code`, `whoami`, `get_platform_guide`.
- **AUTH-3.4** WHEN any other tool is called without an authenticated session THE SYSTEM SHALL return `AUTH_REQUIRED` whose hint instructs the AI to ask the user for their email and call `request_login_code`.
- **AUTH-3.5** WHEN `logout` is called THE SYSTEM SHALL clear the session binding and return `{ authenticated: false }`.
- **AUTH-3.6** WHEN `whoami` is called THE SYSTEM SHALL return `{ authenticated: true, email, member_since }` for a bound session, otherwise `{ authenticated: false, next_step }`.
- **AUTH-3.7** WHEN a bound user becomes `blocked` THE SYSTEM SHALL reject their next tool call with `ACCOUNT_BLOCKED` and clear the binding.

## Non-functional requirements

- `request_login_code` p95 < 1.5 s (dominated by the Resend call).
- Login codes use `crypto.getRandomValues` with rejection sampling (uniform 000000–999999).
- Per-email rate limits count rows in D1 (`login_codes`); the per-session limit is kept in the MCP session's Durable Object. Neither relies on isolate memory, so both hold across isolates.
- Rate limits are per email and per MCP session only; IP limits are meaningless because traffic comes from AI providers' servers.

## Out of scope

- OAuth / API keys / personal access tokens.
- Passwords, social login, 2FA.
- Web sign-in pages.
- Account deletion and email change (later spec).
- Remembering logins across MCP sessions (see open questions).
