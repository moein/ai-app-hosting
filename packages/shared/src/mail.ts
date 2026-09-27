import type { PlatformErrorJson } from './errors';

/** RPC contract of the email worker's PlatformMail entrypoint (spec 11, MAIL-3). */
export type SendLoginCodeInput = { to: string; code: string; codeId: string };
export type SendLoginCodeResult = { ok: true; id: string } | { ok: false; error: PlatformErrorJson };

export interface PlatformMailRpc {
  sendLoginCode(input: SendLoginCodeInput): Promise<SendLoginCodeResult>;
}

/** Messages on the EMAIL_JOBS queue (consumed by the email worker, spec 11). */
export type EmailJob =
  | { type: 'org.provision_email_tenant'; orgId: string }
  | { type: 'app.provision_email_identity'; appId: string };

/** An app's sending domain and address (spec 11): its own SES identity under APPS_DOMAIN. */
export const appMailDomain = (slug: string, appsDomain: string) => `mail.${slug}.${appsDomain}`;
export const appSenderAddress = (slug: string, appsDomain: string) => `hello@${appMailDomain(slug, appsDomain)}`;

/** What app code passes to `env.EMAIL.send` (spec 11, documented in the guide's email topic). */
export type AppEmailMessage = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  reply_to?: string;
  from_name?: string;
};

export const APP_EMAIL_ERROR_CODES = [
  'invalid_message',
  'all_suppressed',
  'quota_exceeded',
  'tenant_not_ready',
  'tenant_paused',
  'send_failed',
] as const;
export type AppEmailErrorCode = (typeof APP_EMAIL_ERROR_CODES)[number];

export type AppEmailResult =
  | { ok: true; id: string; suppressed: string[] }
  | { ok: false; error: { code: AppEmailErrorCode; message: string } };

/** Platform-set props of an app's EMAIL binding (RUN-2.1); the only source of the sender's identity (MAIL-2.2). */
export type AppMailProps = { appId: string; orgId: string; slug: string };

/** SES tenant name of an organization (MAIL-1.1). */
export const emailTenantName = (environment: string, orgId: string) => `${environment}-${orgId}`;
