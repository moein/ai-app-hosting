import type { PlatformErrorJson } from './errors';

/** RPC contract of the email worker's PlatformMail entrypoint (spec 11, MAIL-3). */
export type SendLoginCodeInput = { to: string; code: string; codeId: string };
export type SendLoginCodeResult = { ok: true; id: string } | { ok: false; error: PlatformErrorJson };

export interface PlatformMailRpc {
  sendLoginCode(input: SendLoginCodeInput): Promise<SendLoginCodeResult>;
}

/** Messages on the EMAIL_JOBS queue (consumed by the email worker, spec 11). */
export type EmailJob = { type: 'org.provision_email_tenant'; orgId: string };
