# 11 — Email: Tasks

Depends on: 00, 03 (organizations, quota service). Task 3 is needed early by spec 02.

- [ ] **1. SES setup (dev, prod)** — verify `APPS_MAIL_DOMAIN` (DKIM, MAIL FROM, DMARC), configuration sets, SNS topic + event destination, IAM user, production access request; document in runbook. (SES is for customer apps only.)
  Satisfies: MAIL non-functional
  Tests: manual — send a test email in dev.

- [ ] **1b. Resend setup (dev, prod)** — verify `PLATFORM_MAIL_DOMAIN` in Resend (SPF, DKIM, DMARC), create an API key per environment, `wrangler secret put RESEND_API_KEY --env <env>`, set `PLATFORM_MAIL_DOMAIN` var in `apps/email/wrangler.jsonc`; document in runbook.
  Satisfies: MAIL non-functional
  Tests: covered by `F-AUTH-1` on dev.

- [ ] **2. `SesClient` (aws4fetch) + fake**
  `sendEmail`, `createTenant`, `createTenantResourceAssociation`; error mapping (already exists, tenant paused, throttled).
  Satisfies: (infrastructure)
  Tests: SigV4 request shape against recorded fixture; error mapping table.

- [ ] **3. `ResendClient` + `PlatformMail.sendLoginCode`**
  Satisfies: MAIL-3.1, MAIL-3.2, MAIL-3.3, MAIL-3.4, AUTH-1.8
  Tests: Resend fake receives `from` `login@<PLATFORM_MAIL_DOMAIN>` (read from the var), `Idempotency-Key`, text+html containing code and warning; 429/5xx → `UPSTREAM_ERROR`; 401/422 → `INTERNAL`; no code in logs/metrics.

- [ ] **4. Tenant provisioning queue consumer + operator script**
  Satisfies: MAIL-1.1, MAIL-1.2, MAIL-1.3, MAIL-1.4
  Tests: happy path sets `ready`; AlreadyExists paths succeed; retry with backoff; final failure sets `failed` + metric; script enqueues only pending/failed orgs.

- [ ] **5. Schema `email_suppressions`**
  Satisfies: MAIL-4.6 (constraint)
  Tests: global and org rows coexist; duplicate upserts are no-ops.

- [ ] **6. `AppMail.send`**
  Satisfies: MAIL-2.1, MAIL-2.2, MAIL-2.3, MAIL-2.4, MAIL-2.5, MAIL-2.6, MAIL-2.7, MAIL-2.8, MAIL-2.9
  Tests: identity from props only (message fields can't override); from header format + sanitization; each validation failure; partial and full suppression; quota by recipient count incl. refund on SES failure; tenant not ready/paused; deleted app; tags + metrics; never throws.

- [ ] **7. SES events webhook**
  Satisfies: MAIL-4.1, MAIL-4.2, MAIL-4.3, MAIL-4.4, MAIL-4.5, MAIL-4.6
  Tests: valid signature accepted (test cert); bad signature/host/topic → 403; subscription confirmation fetches URL; permanent bounce → global; transient ignored; complaint → org-scoped or global for platform; duplicates idempotent; metrics.

- [ ] **8. Guide `email` topic** (with spec 06 task 1)
  Satisfies: MCP-2.2 (email topic)
  Tests: guide contains `AppEmailMessage`/`AppEmailResult` types and limits matching `limits.ts`.

- [ ] **9. E2E on dev** (spec 12)
  Flows: `F-MAIL-1` (app email via SES arrives in the e2e inbox from `<slug>@APPS_MAIL_DOMAIN`); login-code delivery via Resend is covered by `F-AUTH-1`.
  Satisfies: E2E-3.3
