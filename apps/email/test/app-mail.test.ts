import { env } from 'cloudflare:workers';
import { Logger, MAX_EMAIL_BYTES, MAX_EMAIL_RECIPIENTS, MAX_EMAILS_PER_ORG_PER_DAY } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { type AppMailDeps, sendAppEmail } from '../src/app-mail/send';
import { sanitizeFromName } from '../src/app-mail/validate';
import { SesError } from '../src/integrations/ses';
import { fakeSes } from './fakes/ses';
import { emailsUsedToday, seedApp, suppress } from './seed';

const NOW = Date.UTC(2026, 8, 27, 12);
function deps() {
  const ses = fakeSes();
  const d: AppMailDeps = {
    db: env.DB,
    ses: ses.client,
    environment: 'dev',
    appsMailDomain: 'mail.dev.motad.app',
    configurationSet: 'apps-dev',
    now: () => NOW,
    logger: new Logger({ test: true }),
  };
  return { deps: d, ses };
}
const msg = (overrides: Record<string, unknown> = {}) => ({
  to: 'Friend@Example.com',
  subject: 'Welcome',
  text: 'Hi!',
  ...overrides,
});

describe('AppMail.send (MAIL-2)', () => {
  it('sends through the org tenant from <slug>@APPS_MAIL_DOMAIN with tags (MAIL-2.1, 2.3, 2.9)', async () => {
    const { deps: d, ses } = deps();
    const { props, orgId, appId, slug } = await seedApp();
    const result = await sendAppEmail(d, props, msg({ html: '<b>Hi</b>', reply_to: 'Owner@Example.com' }));
    expect(result).toEqual({ ok: true, id: 'msg-1', suppressed: [] });
    expect(ses.sent[0]).toEqual({
      from: `"Todo List" <${slug}@mail.dev.motad.app>`,
      to: ['friend@example.com'],
      replyTo: 'owner@example.com',
      subject: 'Welcome',
      text: 'Hi!',
      html: '<b>Hi</b>',
      configurationSet: 'apps-dev',
      tenant: `dev-${orgId}`,
      tags: { env: 'dev', org_id: orgId, app_id: appId },
    });
    expect(await emailsUsedToday(orgId, NOW)).toBe(1);
  });

  it('takes identity only from props — message fields cannot override it (MAIL-2.2)', async () => {
    const { deps: d, ses } = deps();
    const { props, orgId, slug } = await seedApp();
    const other = await seedApp();
    await sendAppEmail(
      d,
      props,
      msg({ from: 'ceo@bank.com', appId: other.appId, orgId: other.orgId, slug: other.slug, tenant: 'x' }),
    );
    expect(ses.sent[0]?.from).toBe(`"Todo List" <${slug}@mail.dev.motad.app>`);
    expect(ses.sent[0]?.tenant).toBe(`dev-${orgId}`);
  });

  it('sanitizes from_name and encodes non-ASCII names (MAIL-2.3)', async () => {
    expect(sanitizeFromName('  "Evil" <x@y.z>\r\nBcc: a  ')).toBe('Evil x@y.zBcc: a');
    expect(sanitizeFromName('x'.repeat(100))).toHaveLength(64);
    const { deps: d, ses } = deps();
    const { props, slug } = await seedApp();
    await sendAppEmail(d, props, msg({ from_name: 'Café "Bob"' }));
    expect(ses.sent[0]?.from).toBe(
      `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode('Café Bob')))}?= <${slug}@mail.dev.motad.app>`,
    );
    await sendAppEmail(d, props, msg({ from_name: '"<>"' }));
    expect(ses.sent[1]?.from).toBe(`"Todo List" <${slug}@mail.dev.motad.app>`);
  });

  it.each([
    ['not an object', 'hello'],
    ['no recipients', msg({ to: [] })],
    [
      'too many recipients',
      msg({ to: Array.from({ length: MAX_EMAIL_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`) }),
    ],
    ['bad address', msg({ to: ['ok@example.com', 'not-an-email'] })],
    ['header injection in address', msg({ to: 'a@example.com\r\nBcc: b@example.com' })],
    ['empty subject', msg({ subject: '' })],
    ['long subject', msg({ subject: 'x'.repeat(201) })],
    ['subject with line break', msg({ subject: 'a\nBcc: x' })],
    ['no body', msg({ text: undefined })],
    ['non-string html', msg({ html: 42 })],
    ['bad reply_to', msg({ reply_to: 'nope' })],
    ['too large', msg({ text: 'x'.repeat(MAX_EMAIL_BYTES) })],
  ])('rejects %s with invalid_message (MAIL-2.4)', async (_, input) => {
    const { deps: d, ses } = deps();
    const { props, orgId } = await seedApp();
    const result = await sendAppEmail(d, props, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(ses.sent).toHaveLength(0);
    expect(await emailsUsedToday(orgId, NOW)).toBe(0);
  });

  it('drops suppressed recipients, global or of this org only (MAIL-2.5)', async () => {
    const { deps: d, ses } = deps();
    const { props, orgId } = await seedApp();
    const other = await seedApp();
    await suppress('bounced@example.com', null);
    await suppress('complained@example.com', orgId, 'complaint');
    await suppress('ok@example.com', other.orgId, 'complaint'); // another org's complaint doesn't apply
    const result = await sendAppEmail(
      d,
      props,
      msg({ to: ['bounced@example.com', 'complained@example.com', 'ok@example.com', 'OK@example.com'] }),
    );
    expect(result).toEqual({ ok: true, id: 'msg-1', suppressed: ['bounced@example.com', 'complained@example.com'] });
    expect(ses.sent[0]?.to).toEqual(['ok@example.com']);
    expect(await emailsUsedToday(orgId, NOW)).toBe(1);

    const all = await sendAppEmail(d, props, msg({ to: ['bounced@example.com'] }));
    expect(all).toMatchObject({ ok: false, error: { code: 'all_suppressed' } });
  });

  it('counts each recipient against the daily quota (MAIL-2.6)', async () => {
    const { deps: d, ses } = deps();
    const { props, orgId } = await seedApp();
    await env.DB.prepare("INSERT INTO usage_counters (org_id, metric, day, count) VALUES (?, 'emails', ?, ?)")
      .bind(orgId, '2026-09-27', MAX_EMAILS_PER_ORG_PER_DAY - 2)
      .run();
    const three = await sendAppEmail(d, props, msg({ to: ['a@example.com', 'b@example.com', 'c@example.com'] }));
    expect(three).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(await sendAppEmail(d, props, msg({ to: ['a@example.com', 'b@example.com'] }))).toMatchObject({ ok: true });
    expect(await emailsUsedToday(orgId, NOW)).toBe(MAX_EMAILS_PER_ORG_PER_DAY);
    expect(ses.sent).toHaveLength(1);
  });

  it('refunds the quota when SES fails, mapping paused tenants (MAIL-2.7)', async () => {
    const { deps: d, ses } = deps();
    const { props, orgId } = await seedApp();
    ses.fail('sendEmail', new SesError('SendingPausedException', 400, 'paused'));
    expect(await sendAppEmail(d, props, msg())).toMatchObject({ ok: false, error: { code: 'tenant_paused' } });
    ses.fail('sendEmail', new SesError('NotFoundException', 404, 'no tenant'));
    expect(await sendAppEmail(d, props, msg())).toMatchObject({ ok: false, error: { code: 'tenant_not_ready' } });
    ses.fail('sendEmail', new SesError('MessageRejected', 400, 'bad'));
    expect(await sendAppEmail(d, props, msg())).toMatchObject({ ok: false, error: { code: 'send_failed' } });
    expect(await emailsUsedToday(orgId, NOW)).toBe(0);
  });

  it('refuses when the tenant is not ready or the app is deleted (MAIL-2.7, 2.8)', async () => {
    const { deps: d, ses } = deps();
    for (const tenant of ['pending', 'failed'] as const) {
      const { props } = await seedApp({ tenant });
      expect(await sendAppEmail(d, props, msg())).toMatchObject({ ok: false, error: { code: 'tenant_not_ready' } });
    }
    const deleted = await seedApp({ appStatus: 'deleted' });
    expect(await sendAppEmail(d, deleted.props, msg())).toMatchObject({ ok: false, error: { code: 'send_failed' } });
    expect(await sendAppEmail(d, { appId: 'app_missing0000', orgId: 'org_x', slug: 'x' }, msg())).toMatchObject({
      ok: false,
      error: { code: 'send_failed' },
    });
    expect(ses.sent).toHaveLength(0);
  });

  it('never throws, even when the database fails', async () => {
    const { deps: d } = deps();
    const { props } = await seedApp();
    const broken = {
      ...d,
      db: {
        prepare: () => {
          throw new Error('D1 down');
        },
      } as unknown as D1Database,
    };
    await expect(sendAppEmail(broken, props, msg())).resolves.toMatchObject({
      ok: false,
      error: { code: 'send_failed' },
    });
  });
});
