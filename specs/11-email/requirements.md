# 11 — Email: Requirements

The platform sends two kinds of email through two providers:
- **Platform emails** (login codes, spec 02) go through **Resend**, from `login@PLATFORM_MAIL_DOMAIN`.
- **Customer app emails** — sent by user apps through their `EMAIL` binding — go through **AWS SES v2**, from `<slug>@APPS_MAIL_DOMAIN`. Each organization gets its own SES tenant so one org's sending reputation can't harm others.

SES is used only for customer apps; Resend only for the platform.

## Stories & acceptance criteria

### MAIL-1 — SES tenant per organization
As the operator, I want every organization isolated in its own SES tenant, so that a spammy app can be paused without affecting everyone else.

- **MAIL-1.1** WHEN an `org.provision_email_tenant` job is received THE SYSTEM SHALL create the SES tenant `<env>-<org_id>`, associate the `APPS_MAIL_DOMAIN` identity and the environment's configuration set with it, and set `organizations.email_tenant_status = 'ready'`.
- **MAIL-1.2** THE SYSTEM SHALL make tenant provisioning idempotent (an existing tenant or association counts as success).
- **MAIL-1.3** IF provisioning still fails after the queue's max retries THEN THE SYSTEM SHALL set `email_tenant_status = 'failed'` and write a `provisioning_failed` metric (sub = `email_tenant`).
- **MAIL-1.4** THE SYSTEM SHALL provide an operator script to re-enqueue provisioning for all orgs with status `pending` or `failed`.

### MAIL-2 — Apps send email
As a user, I want my app to send emails (welcome messages, notifications), so that it feels like a real product.

- **MAIL-2.1** WHEN app code calls `env.EMAIL.send(message)` THE SYSTEM SHALL send it through SES using the app's org tenant and return `{ ok: true, id, suppressed }`, or `{ ok: false, error: { code, message } }` without throwing.
- **MAIL-2.2** THE SYSTEM SHALL identify the sending app and org only from the binding's platform-set `props` (RUN-2.1), never from the message.
- **MAIL-2.3** THE SYSTEM SHALL send from `"<from_name or app name>" <<slug>@APPS_MAIL_DOMAIN>`, where `from_name` is sanitized (no quotes, angle brackets or line breaks; ≤ 64 chars).
- **MAIL-2.4** IF the message has no recipients or more than `MAX_EMAIL_RECIPIENTS`, an invalid address, a subject outside 1–200 chars, neither `text` nor `html`, or exceeds `MAX_EMAIL_BYTES` THEN THE SYSTEM SHALL return `invalid_message`.
- **MAIL-2.5** THE SYSTEM SHALL remove suppressed recipients (global or the org's), report them in `suppressed`, and IF all recipients are suppressed THEN return `all_suppressed`.
- **MAIL-2.6** THE SYSTEM SHALL count each remaining recipient against `MAX_EMAILS_PER_ORG_PER_DAY` (APP-5) before sending, and IF exceeded THEN return `quota_exceeded`.
- **MAIL-2.7** IF the org's tenant is not `ready` THEN THE SYSTEM SHALL return `tenant_not_ready`; IF SES reports the tenant paused THEN `tenant_paused`; other SES failures SHALL return `send_failed`.
- **MAIL-2.8** IF the app is deleted THEN THE SYSTEM SHALL return `send_failed` and not send.
- **MAIL-2.9** THE SYSTEM SHALL tag every SES message with `env`, `org_id` and `app_id` and write `email_sent` / `email_rejected` metrics.

### MAIL-3 — Login-code emails
As a user, I want my login code to arrive quickly and look trustworthy.

- **MAIL-3.1** WHEN `PlatformMail.sendLoginCode({ to, code })` is called THE SYSTEM SHALL send a plain-text + HTML email through the Resend API from `login@<PLATFORM_MAIL_DOMAIN>`, where `PLATFORM_MAIL_DOMAIN` is a dedicated `vars` entry in the email worker's `wrangler.jsonc`, with content per AUTH-1.8.
- **MAIL-3.2** THE SYSTEM SHALL NOT log the code or include it in metrics or events.
- **MAIL-3.3** IF Resend responds with 429 or 5xx, or the request fails THEN `sendLoginCode` SHALL fail with `UPSTREAM_ERROR` (retryable); other 4xx responses SHALL fail with `INTERNAL` and be logged (configuration problem).
- **MAIL-3.4** THE SYSTEM SHALL send each login-code email with an `Idempotency-Key` equal to the login code's ID, so retries never send duplicates.

### MAIL-4 — Bounces and complaints
As the operator, I want to stop sending to addresses that bounce or complain, so that our reputation stays healthy.

- **MAIL-4.1** THE SYSTEM SHALL receive SES events via SNS at `POST /v1/ses/events`, verifying each SNS message signature (certificate host `sns.<region>.amazonaws.com`) and rejecting invalid ones with 403.
- **MAIL-4.2** WHEN an SNS `SubscriptionConfirmation` for the configured topic arrives THE SYSTEM SHALL confirm it by fetching its `SubscribeURL`.
- **MAIL-4.3** WHEN a `Bounce` event with `bounceType = Permanent` arrives THE SYSTEM SHALL add each bounced recipient to the suppression list globally.
- **MAIL-4.4** WHEN a `Complaint` event arrives THE SYSTEM SHALL suppress the recipient for the originating org (from the message tag).
- **MAIL-4.5** THE SYSTEM SHALL write `email_bounced` / `email_complained` metrics with the org ID.
- **MAIL-4.6** THE SYSTEM SHALL ignore transient bounces and duplicate events (idempotent upsert).

## Non-functional requirements

- `env.EMAIL.send` p95 < 1 s.
- SES production access (out of sandbox) in prod; DKIM, custom MAIL FROM and DMARC configured for `APPS_MAIL_DOMAIN`.
- `PLATFORM_MAIL_DOMAIN` verified in Resend (SPF, DKIM, DMARC).

## Out of scope

- Custom sender domains per app/org, attachments, CC/BCC, receiving email.
- Email templates or marketing features.
- MCP tools for email (the AI uses the binding from app code; limits are in the guide).
- Resend webhooks: bounces/complaints of platform emails are handled by Resend's own suppression list in v1.
