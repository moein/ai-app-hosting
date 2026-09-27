import type { Logger, Metrics } from '@repo/shared';
import { z } from 'zod';
import type { Db } from '../db/client';
import { suppress } from './suppressions';

const Recipients = z.array(z.object({ emailAddress: z.string() })).default([]);
const SesEventSchema = z.object({
  eventType: z.string(),
  mail: z.object({ tags: z.record(z.string(), z.array(z.string())).default({}) }).default({ tags: {} }),
  bounce: z.object({ bounceType: z.string(), bouncedRecipients: Recipients }).optional(),
  complaint: z.object({ complainedRecipients: Recipients }).optional(),
});

/** SNS addresses may come as `"Name" <a@b.c>`. */
const bareAddress = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();

/** Applies one SES event (MAIL-4.3–4.6). Returns what it did, for logging and tests. */
export async function applySesEvent(
  db: Db,
  raw: unknown,
  now: number,
  logger: Logger,
  metrics: Metrics,
): Promise<{ action: 'suppressed' | 'ignored'; count: number }> {
  const parsed = SesEventSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('unrecognized SES event', { issues: parsed.error.issues.length });
    return { action: 'ignored', count: 0 };
  }
  const event = parsed.data;
  const orgId = event.mail.tags.org_id?.[0] ?? null;

  if (event.eventType === 'Bounce' && event.bounce?.bounceType === 'Permanent') {
    const emails = event.bounce.bouncedRecipients.map((r) => bareAddress(r.emailAddress));
    for (const email of emails) await suppress(db, { email, orgId: null, reason: 'bounce', now });
    metrics.write('email_bounced', { orgId, appId: event.mail.tags.app_id?.[0] ?? null, bytes: emails.length });
    logger.info('permanent bounce suppressed', { orgId, count: emails.length });
    return { action: 'suppressed', count: emails.length };
  }
  if (event.eventType === 'Complaint' && event.complaint) {
    const emails = event.complaint.complainedRecipients.map((r) => bareAddress(r.emailAddress));
    for (const email of emails) await suppress(db, { email, orgId, reason: 'complaint', now });
    metrics.write('email_complained', { orgId, appId: event.mail.tags.app_id?.[0] ?? null, bytes: emails.length });
    logger.info('complaint suppressed', { orgId, count: emails.length });
    return { action: 'suppressed', count: emails.length };
  }
  return { action: 'ignored', count: 0 };
}
