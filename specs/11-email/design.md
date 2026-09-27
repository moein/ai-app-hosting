# 11 — Email: Design

## Components

```
apps/api  ──EMAIL_JOBS queue──▶ apps/email (queue consumer: org.provision_email_tenant) ──▶ SES v2 CreateTenant / associations
apps/api  ──MAIL (service binding, entrypoint PlatformMail)──▶ apps/email ──▶ Resend API (from login@PLATFORM_MAIL_DOMAIN)
app script ──EMAIL (service binding, entrypoint AppMail, props)──▶ apps/email ──▶ SES SendEmail (tenant <env>-<org_id>)
SES ──config set event destination──▶ SNS topic ──HTTPS──▶ apps/api POST /v1/ses/events ──▶ D1 email_suppressions
```

`apps/email` bindings: `DB` (platform D1: orgs, apps, suppressions, usage counters), `METRICS`, queue consumer `email-jobs-<env>`; secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESEND_API_KEY`; vars `AWS_REGION`, `SES_CONFIGURATION_SET`, `APPS_MAIL_DOMAIN`, `PLATFORM_MAIL_DOMAIN` (its own var, used only for platform emails). AWS requests are SigV4-signed with `aws4fetch`.

DNS records for SES identities (DKIM CNAMEs, custom MAIL FROM MX/SPF, DMARC) are created through the Cloudflare DNS API with `CF_API_TOKEN` (Zone DNS Edit on the `APPS_DOMAIN` zone) — by the setup script now, and by per-org provisioning later (backlog item 1).

The AWS IAM user is limited to `ses:SendEmail`, `ses:CreateTenant`, `ses:GetTenant`, `ses:CreateTenantResourceAssociation` on the relevant resources.

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
org = D1 organizations by props.orgId; tenant status != ready → tenant_not_ready
recipients = dedupe(lowercase(to)); suppressed = D1 email_suppressions where email IN recipients
                                                  AND (org_id IS NULL OR org_id = orgId)
remaining = recipients − suppressed; empty      → all_suppressed
consumeDaily('emails', count = remaining.length) → quota_exceeded   (atomic check-and-add, spec 03)
SES v2 SendEmail {
  FromEmailAddress: `"${fromName}" <${slug}@${APPS_MAIL_DOMAIN}>`,
  Destination: { ToAddresses: remaining }, ReplyToAddresses,
  Content: { Simple: { Subject, Body: { Text, Html } } },
  ConfigurationSetName, TenantName: `${env}-${orgId}`,
  EmailTags: [env, org_id, app_id]
}
  SES error "tenant paused"/sending paused      → tenant_paused
  other error                                   → send_failed (refund quota)
metrics email_sent (sub 'app') / email_rejected (sub = code)
```

## Tenant provisioning job

Message: `{ type: 'org.provision_email_tenant', orgId }`. Consumer:

```
CreateTenant(TenantName = `${env}-${orgId}`, Tags [org_id, env])      AlreadyExists → ok
CreateTenantResourceAssociation(identity ARN of APPS_MAIL_DOMAIN)       AlreadyExists → ok
CreateTenantResourceAssociation(configuration set ARN)                  AlreadyExists → ok
UPDATE organizations SET email_tenant_status='ready'
failure → message.retry({ delaySeconds: backoff }); on final attempt (max_retries 10) → status 'failed' + metric
```

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

0. Per-org sending subdomains are planned — see [backlog](../backlog.md) item 1.

1. SES tenant reputation policy settings (automatic pause thresholds) — use SES defaults initially?
2. Custom sender domains per org (would add identity verification flows to MCP).
3. Should `env.EMAIL.send` be async via a queue to smooth SES rate limits (account max send rate)?
4. Separate AWS account/region for dev.
