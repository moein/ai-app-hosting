# 11 — Email: Design

## Components

```
apps/api  ──EMAIL_JOBS queue──▶ apps/email (queue consumer: org.provision_email_tenant) ──▶ SES v2 CreateTenant / associations
apps/api  ──MAIL (service binding, entrypoint PlatformMail)──▶ apps/email ──▶ Resend API (from login@PLATFORM_MAIL_DOMAIN)
apps/api  ──EMAIL_JOBS queue──▶ apps/email (app.provision_email_identity) ──▶ SES CreateEmailIdentity + Cloudflare DNS (DKIM) + tenant association
app script ──EMAIL (service binding, entrypoint AppMail, props)──▶ apps/email ──▶ SES SendEmail (from hello@mail.<slug>.APPS_DOMAIN, tenant <env>-<org_id>)
SES ──config set event destination──▶ SNS topic ──HTTPS──▶ apps/api POST /v1/ses/events ──▶ D1 email_suppressions
```

`apps/email` bindings: `DB` (platform D1: orgs, apps, suppressions, usage counters — plain SQL; the api owns the schema and migrations, and the email worker's tests apply the api's migrations), `METRICS`, queue consumer `email-jobs-<env>` (`max_retries: 10`); secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESEND_API_KEY`, `CF_API_TOKEN` (DNS edit on the `APPS_DOMAIN` zone, for per-app DKIM records); vars `AWS_REGION`, `SES_CONFIGURATION_SET`, `APPS_DOMAIN`, `PLATFORM_MAIL_DOMAIN` (its own var, used only for platform emails). AWS requests are SigV4-signed with `aws4fetch`.

## Per-app sending domain

Every app sends from its own SES domain identity `mail.<slug>.APPS_DOMAIN` (address `hello@mail.<slug>.APPS_DOMAIN`), so mailbox providers build reputation per app. Per identity the platform creates only the three Easy DKIM CNAMEs (`<token>._domainkey.mail.<slug>.APPS_DOMAIN` → `<token>.dkim.amazonses.com`, DNS only) in the `APPS_DOMAIN` zone through the Cloudflare DNS API. No per-app custom MAIL FROM: DKIM is aligned with the From domain, which is what DMARC needs, and it keeps the zone at 3 records per app. One DMARC record at the zone apex (`_dmarc.APPS_DOMAIN`, created by the setup script) covers every app subdomain.

`apps.email_status` (`pending` → `ready` | `failed`) tracks the identity; `AppMail.send` requires it to be `ready`.

The AWS IAM user is limited to `ses:SendEmail`, `ses:CreateTenant`, `ses:GetTenant`, `ses:CreateTenantResourceAssociation`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity` on the relevant resources.

### Setup (`scripts/setup-ses.mjs <env>`, idempotent)

The AWS account is shared with unrelated projects, so the script only creates/updates resources it names and never lists-and-modifies others. It reads AWS keys and `CF_API_TOKEN` from `.env.<env>` and `APPS_DOMAIN` / `AWS_REGION` / `SES_CONFIGURATION_SET` from `apps/email/wrangler.jsonc`.

1. DMARC TXT `_dmarc.APPS_DOMAIN` = `v=DMARC1; p=none;` — created only if the apex has no DMARC record yet (tighten to `quarantine` after a clean week of reports). It covers every `mail.<slug>` subdomain.
2. Configuration set `apps-<env>` (reputation metrics on).
3. SNS topic `ses-events-<env>` (attribute `SignatureVersion` = 2; topic policy lets `ses.amazonaws.com` publish, conditioned on the account), configuration-set event destination (`BOUNCE`, `COMPLAINT`) → topic, HTTPS subscription to `PLATFORM_API_ORIGIN/v1/ses/events`, and `SES_EVENTS_TOPIC_ARN` appended to `.env.<env>` (uploaded as an api secret by `pnpm secrets:<env>`). Needs `sns:CreateTopic`, `sns:Subscribe`, `sns:GetTopicAttributes`, `sns:SetTopicAttributes`; the step is skipped with a message when the key lacks them.

DNS records are created in the `APPS_DOMAIN` zone (DNS only, not proxied). Per-app identities are not created by the script but by the email worker (below). SES production access is an account-level setting (already enabled on the shared account; `GET /v2/email/account` shows `ProductionAccessEnabled`).

The AWS account id is never committed: the email worker resolves it once per isolate with STS `GetCallerIdentity` (needs no IAM permission) to build identity and configuration-set ARNs for tenant associations; the api gets the full topic ARN as the `SES_EVENTS_TOPIC_ARN` secret. While that secret is unset, `/v1/ses/events` answers 403 to everything.

## Entrypoints

```ts
// apps/email/src/index.ts
export class PlatformMail extends WorkerEntrypoint<Env> {
  sendLoginCode(p: { to: string; code: string; codeId: string }): Promise<{ ok: true; id: string } | { ok: false; error: PlatformErrorJson }>;
}

export class AppMail extends WorkerEntrypoint<Env, { appId: string; orgId: string; slug: string }> {
  send(msg: AppEmailMessage): Promise<AppEmailResult>;      // identity = this.ctx.props (MAIL-2.2)
}

export default { queue: handleEmailJobs } satisfies ExportedHandler<Env>;
```

### App-facing API (documented in the guide's `email` topic)

```ts
type AppEmailMessage = {
  to: string | string[];          // 1..MAX_EMAIL_RECIPIENTS
  subject: string;                // 1..200
  text?: string; html?: string;   // at least one
  reply_to?: string;
  from_name?: string;             // default: app name
};
type AppEmailResult =
  | { ok: true; id: string; suppressed: string[] }
  | { ok: false; error: { code: 'invalid_message' | 'all_suppressed' | 'quota_exceeded'
                              | 'tenant_not_ready' | 'tenant_paused' | 'send_failed'; message: string } };
```

`src/api/env.ts` in apps declares `EMAIL: { send(msg: AppEmailMessage): Promise<AppEmailResult> }` (types given in the guide).

### `AppMail.send` algorithm

```
validate(msg)                                   → invalid_message
app = D1 apps by props.appId; if deleted        → send_failed
org = D1 organizations by props.orgId; tenant status != ready, or app.email_status != ready → tenant_not_ready
recipients = dedupe(lowercase(to)); suppressed = D1 email_suppressions where email IN recipients
                                                  AND (org_id IS NULL OR org_id = orgId)
remaining = recipients − suppressed; empty      → all_suppressed
consumeDaily('emails', count = remaining.length) → quota_exceeded   (atomic check-and-add, spec 03)
SES v2 SendEmail {
  FromEmailAddress: `"${fromName}" <hello@mail.${slug}.${APPS_DOMAIN}>`,
  Destination: { ToAddresses: remaining }, ReplyToAddresses,
  Content: { Simple: { Subject, Body: { Text, Html } } },
  ConfigurationSetName, TenantName: `${env}-${orgId}`,
  EmailTags: [env, org_id, app_id]
}
  SES SendingPausedException                    → tenant_paused
  SES NotFoundException (tenant missing)        → tenant_not_ready
  other error                                   → send_failed (refund quota on every SES error)
metrics email_sent (sub 'app') / email_rejected (sub = code)
```

## Tenant provisioning job

Message: `{ type: 'org.provision_email_tenant', orgId }`. Consumer:

```
CreateTenant(TenantName = `${env}-${orgId}`, Tags [org_id, env])      AlreadyExists → ok
CreateTenantResourceAssociation(configuration set ARN)                  AlreadyExists → ok
UPDATE organizations SET email_tenant_status='ready'
failure → message.retry({ delaySeconds: backoff }); on final attempt (max_retries 10) → status 'failed' + metric
```

Message `{ type: 'app.provision_email_identity', appId }` (enqueued by `ProvisionApp`, MAIL-1.5):

```
app (active) + org tenant status; tenant not ready                     → retry (backoff)
CreateEmailIdentity(mail.<slug>.APPS_DOMAIN, ConfigurationSetName,
                    Tags [app_id, org_id, env])                         AlreadyExists → ok
GetEmailIdentity → DKIM tokens → upsert 3 CNAMEs in the APPS_DOMAIN zone (zone id looked up by name, cached)
CreateTenantResourceAssociation(tenant, identity ARN)                   AlreadyExists → ok
VerificationStatus = SUCCESS → UPDATE apps SET email_status='ready'; ack
otherwise                                                               → retry (backoff: 10 s … 15 min)
final attempt still unverified → email_status='failed' + provisioning_failed (sub email_identity)
```

Backoff `min(10 s · 2^(attempt-1), 15 min)` over 10 retries gives verification about 1.5 hours; DKIM usually verifies within minutes. Retries re-run every step, which is safe because each is idempotent.

## Platform email via Resend (`PlatformMail`)

`ResendClient` (interface + fake, like the other integrations):

```
POST https://api.resend.com/emails
Authorization: Bearer RESEND_API_KEY
Idempotency-Key: login-code/<codeId>                  (MAIL-3.4)
{ "from": "Login <login@${PLATFORM_MAIL_DOMAIN}>", "to": [to], "subject": "Your login code: 482913",
  "text": "…", "html": "…", "tags": [{ "name": "env", "value": env }, { "name": "kind", "value": "login_code" }] }
```

- 200 → `{ id }`; 429 / 5xx / network → `UPSTREAM_ERROR` (retryable); other 4xx → `INTERNAL` + log (bad key, unverified domain).
- The login code is never logged; only Resend's message id is.
- Resend keeps its own suppression list for platform emails; AUTH-1.7 additionally checks our global suppressions (hard bounces seen by SES).

## Data model

```sql
CREATE TABLE email_suppressions (
  email       TEXT NOT NULL,          -- normalized
  org_id      TEXT,                   -- NULL = global
  reason      TEXT NOT NULL,          -- 'bounce' | 'complaint'
  created_at  INTEGER NOT NULL,
  UNIQUE (email, org_id)
);
CREATE INDEX email_suppressions_email ON email_suppressions (email);
```

Note: SQLite treats NULLs as distinct in UNIQUE; global rows are upserted via `INSERT … WHERE NOT EXISTS (SELECT 1 … WHERE email = ? AND org_id IS NULL)`.

AUTH-1.7 checks `org_id IS NULL` rows only.

## SES events webhook (`apps/api`)

`sesRoutes` (`src/http/routes/ses.ts`) mounted at `/v1/ses`, with `snsSignature()` middleware attached inside the group (steps 1 below), exposing `POST /events`:
1. Parse SNS envelope; verify `SignatureVersion` 2 (SHA256) signature using the cert at `SigningCertURL` (host must match `^sns\.[a-z0-9-]+\.amazonaws\.com$`, cert cached); `TopicArn` must equal configured `SES_EVENTS_TOPIC_ARN`.
2. `SubscriptionConfirmation` → GET `SubscribeURL`.
3. `Notification` → parse SES event JSON: `eventType` `Bounce` (Permanent only) → global suppression; `Complaint` → org suppression (from `mail.tags.org_id`) .
4. Respond 200 (also for ignored events).

## Limits

| Constant | Value |
|---|---|
| `MAX_EMAIL_RECIPIENTS` | 50 |
| `MAX_EMAIL_BYTES` | 256_000 |
| `MAX_EMAILS_PER_ORG_PER_DAY` | 300 (spec 03) |

## Open questions

0. DNS record budget: 3 records per app in the `APPS_DOMAIN` zone (Cloudflare zones have a record quota by plan) — watch it as apps grow.

1. SES tenant reputation policy settings (automatic pause thresholds) — use SES defaults initially?
2. Custom sender domains per org (would add identity verification flows to MCP).
3. Should `env.EMAIL.send` be async via a queue to smooth SES rate limits (account max send rate)?
4. Separate AWS account/region for dev.
