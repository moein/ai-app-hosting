import {
  type AppEmailErrorCode,
  type AppEmailResult,
  type AppMailProps,
  emailTenantName,
  type Logger,
  MAX_EMAILS_PER_ORG_PER_DAY,
} from '@repo/shared';
import { consumeEmails, findApp, refundEmails, suppressedAmong, tenantStatus } from '../db';
import { type SesClient, SesError } from '../integrations/ses';
import { sanitizeFromName, validateMessage } from './validate';

export type AppMailDeps = {
  db: D1Database;
  ses: SesClient;
  environment: 'dev' | 'prod';
  appsMailDomain: string;
  configurationSet: string;
  now: () => number;
  logger: Logger;
};

const fail = (code: AppEmailErrorCode, message: string): AppEmailResult => ({ ok: false, error: { code, message } });

/** RFC 2047 encoded-word for non-ASCII display names. */
const displayName = (name: string) =>
  /^[\x20-\x7e]*$/.test(name)
    ? `"${name}"`
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(name)))}?=`;

/** `env.EMAIL.send` of an app (MAIL-2). Never throws. */
export async function sendAppEmail(deps: AppMailDeps, props: AppMailProps, input: unknown): Promise<AppEmailResult> {
  const logger = deps.logger.child({ appId: props.appId, orgId: props.orgId });
  try {
    const validated = validateMessage(input);
    if (!validated.ok) return fail('invalid_message', validated.reason);
    const msg = validated.message;

    const app = await findApp(deps.db, props.appId);
    if (app?.status !== 'active') return fail('send_failed', 'This app is deleted and cannot send email.');
    if ((await tenantStatus(deps.db, props.orgId)) !== 'ready') {
      return fail(
        'tenant_not_ready',
        'Email sending is still being set up for this account. Try again in a few minutes.',
      );
    }

    const suppressed = await suppressedAmong(deps.db, props.orgId, msg.to);
    const remaining = msg.to.filter((address) => !suppressed.has(address));
    if (remaining.length === 0) {
      return fail('all_suppressed', 'Every recipient previously bounced or complained, so nothing was sent.');
    }

    const now = deps.now();
    if (!(await consumeEmails(deps.db, props.orgId, remaining.length, MAX_EMAILS_PER_ORG_PER_DAY, now))) {
      return fail(
        'quota_exceeded',
        `Daily limit of ${MAX_EMAILS_PER_ORG_PER_DAY} emails reached; it resets at 00:00 UTC.`,
      );
    }

    const fromName = sanitizeFromName(msg.fromName ?? '') || sanitizeFromName(app.name) || props.slug;
    try {
      const { messageId } = await deps.ses.sendEmail({
        from: `${displayName(fromName)} <${props.slug}@${deps.appsMailDomain}>`,
        to: remaining,
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        subject: msg.subject,
        ...(msg.text === undefined ? {} : { text: msg.text }),
        ...(msg.html === undefined ? {} : { html: msg.html }),
        configurationSet: deps.configurationSet,
        tenant: emailTenantName(deps.environment, props.orgId),
        tags: { env: deps.environment, org_id: props.orgId, app_id: props.appId },
      });
      logger.info('app email sent', { messageId, recipients: remaining.length, suppressed: suppressed.size });
      return { ok: true, id: messageId, suppressed: msg.to.filter((address) => suppressed.has(address)) };
    } catch (error) {
      await refundEmails(deps.db, props.orgId, remaining.length, now);
      const type = error instanceof SesError ? error.type : 'Unknown';
      logger.warn('app email rejected by SES', {
        type,
        message: error instanceof Error ? error.message : String(error),
      });
      if (type === 'SendingPausedException') {
        return fail('tenant_paused', 'Email sending is paused for this account (too many bounces or complaints).');
      }
      if (type === 'NotFoundException') {
        return fail(
          'tenant_not_ready',
          'Email sending is still being set up for this account. Try again in a few minutes.',
        );
      }
      return fail('send_failed', 'The email could not be sent. Try again later.');
    }
  } catch (error) {
    logger.error('app email failed', { error });
    return fail('send_failed', 'The email could not be sent. Try again later.');
  }
}
