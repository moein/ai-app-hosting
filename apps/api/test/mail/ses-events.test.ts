import { env } from 'cloudflare:workers';
import { memoryMetrics } from '@repo/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { emailSuppressions } from '../../src/db/schema';
import { createSesRoutes } from '../../src/http/routes/ses';
import { spkiFromCertificate, stringToSign } from '../../src/mail/sns';
import { suppress } from '../../src/mail/suppressions';
import { fakeClock } from '../mcp/helpers';
import { testSigner } from './sns-helpers';

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:ses-events-dev';
let certSeq = 0;

async function setup(options: { topicArn?: string | undefined } = { topicArn: TOPIC }) {
  const signer = await testSigner();
  const certUrl = `https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test${++certSeq}.pem`;
  const fetched: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url === certUrl) return new Response(signer.certPem);
    if (url.includes('Action=ConfirmSubscription')) return new Response('<ConfirmSubscriptionResponse/>');
    return new Response('not found', { status: 404 });
  });
  const db = createDb(env.DB);
  const metrics = memoryMetrics();
  const routes = createSesRoutes(() => ({
    db,
    clock: fakeClock(),
    metrics,
    topicArn: options.topicArn,
    fetch: fetchImpl as typeof fetch,
  }));
  const app = new Hono().route('/v1/ses', routes);
  const base = {
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC,
    Timestamp: '2026-09-27T12:00:00.000Z',
    SignatureVersion: '2',
    SigningCertURL: certUrl,
  };
  const notification = (event: unknown) =>
    signer.sign({ ...base, MessageId: crypto.randomUUID(), Type: 'Notification', Message: JSON.stringify(event) });
  const post = (body: unknown) => app.request('/v1/ses/events', { method: 'POST', body: JSON.stringify(body) }, env);
  return { signer, db, post, notification, base, fetched, metrics };
}

const bounce = (type: string, emails: string[], orgId = 'org_abcdefghijk') => ({
  eventType: 'Bounce',
  mail: { tags: { org_id: [orgId], env: ['dev'] } },
  bounce: { bounceType: type, bouncedRecipients: emails.map((emailAddress) => ({ emailAddress })) },
});
const complaint = (emails: string[], orgId?: string) => ({
  eventType: 'Complaint',
  mail: { tags: orgId ? { org_id: [orgId] } : {} },
  complaint: { complainedRecipients: emails.map((emailAddress) => ({ emailAddress })) },
});
const rows = async (email: string) => {
  const db = createDb(env.DB);
  return (await db.select().from(emailSuppressions).all())
    .filter((r) => r.email === email)
    .map((r) => ({ orgId: r.orgId, reason: r.reason }));
};

describe('SNS message verification (MAIL-4.1)', () => {
  it('builds the canonical string to sign per type', () => {
    const base = {
      MessageId: 'm',
      TopicArn: 't',
      Timestamp: 'ts',
      SignatureVersion: '2',
      Signature: '',
      SigningCertURL: '',
    };
    expect(stringToSign({ ...base, Type: 'Notification', Message: 'hi' })).toBe(
      'Message\nhi\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n',
    );
    expect(stringToSign({ ...base, Type: 'Notification', Message: 'hi', Subject: 's' })).toContain(
      'MessageId\nm\nSubject\ns\nTimestamp',
    );
    expect(
      stringToSign({ ...base, Type: 'SubscriptionConfirmation', Message: 'x', SubscribeURL: 'u', Token: 'k' }),
    ).toBe(
      'Message\nx\nMessageId\nm\nSubscribeURL\nu\nTimestamp\nts\nToken\nk\nTopicArn\nt\nType\nSubscriptionConfirmation\n',
    );
  });

  it('extracts the public key from a certificate', async () => {
    const { signer } = await setup();
    const der = Uint8Array.from(atob(signer.certPem.replace(/-----[A-Z ]+-----|\s/g, '')), (c) => c.charCodeAt(0));
    const spki = spkiFromCertificate(der);
    await expect(
      crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    ).resolves.toBeTruthy();
  });

  it('accepts a correctly signed notification', async () => {
    const { post, notification } = await setup();
    expect((await post(await notification(bounce('Transient', ['x@example.com'])))).status).toBe(200);
  });

  it.each([
    ['tampered message', async (m: Record<string, string>) => ({ ...m, Message: '{"eventType":"Bounce"}' })],
    ['bad signature', async (m: Record<string, string>) => ({ ...m, Signature: btoa('nope') })],
    ['version 1', async (m: Record<string, string>) => ({ ...m, SignatureVersion: '1' })],
    [
      'foreign cert host',
      async (m: Record<string, string>) => ({ ...m, SigningCertURL: 'https://evil.example.com/x.pem' }),
    ],
    [
      'cert host lookalike',
      async (m: Record<string, string>) => ({
        ...m,
        SigningCertURL: 'https://sns.eu-central-1.amazonaws.com.evil.io/x.pem',
      }),
    ],
    [
      'http cert',
      async (m: Record<string, string>) => ({ ...m, SigningCertURL: m.SigningCertURL?.replace('https', 'http') ?? '' }),
    ],
    [
      'other topic',
      async (m: Record<string, string>) => ({ ...m, TopicArn: 'arn:aws:sns:eu-central-1:999999999999:ses-events-dev' }),
    ],
    ['not JSON', async () => 'garbage'],
  ])('rejects %s with 403', async (_, mutate) => {
    const { post, notification } = await setup();
    const signed = (await notification(bounce('Permanent', ['victim@example.com']))) as unknown as Record<
      string,
      string
    >;
    expect((await post(await mutate(signed))).status).toBe(403);
    expect(await rows('victim@example.com')).toEqual([]);
  });

  it('rejects everything while the topic ARN is not configured', async () => {
    const { post, notification } = await setup({ topicArn: undefined });
    expect((await post(await notification(bounce('Permanent', ['a@example.com'])))).status).toBe(403);
  });
});

describe('SES events (MAIL-4.2–4.6)', () => {
  it('confirms a subscription by fetching its SNS SubscribeURL (MAIL-4.2)', async () => {
    const { post, signer, base, fetched } = await setup();
    const subscribeUrl = `https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=abc`;
    const message = await signer.sign({
      ...base,
      Type: 'SubscriptionConfirmation',
      Message: 'confirm',
      SubscribeURL: subscribeUrl,
      Token: 'abc',
    });
    expect((await post(message)).status).toBe(200);
    expect(fetched).toContain(subscribeUrl);

    const evil = await signer.sign({
      ...base,
      Type: 'SubscriptionConfirmation',
      Message: 'x',
      SubscribeURL: 'https://evil.example.com/',
      Token: 'abc',
    });
    expect((await post(evil)).status).toBe(403);
  });

  it('suppresses permanent bounces globally and ignores transient ones (MAIL-4.3, 4.6, 4.5)', async () => {
    const { post, notification, metrics } = await setup();
    await post(await notification(bounce('Permanent', ['Hard@Example.com', '"Name" <other@example.com>'])));
    await post(await notification(bounce('Transient', ['soft@example.com'])));
    expect(await rows('hard@example.com')).toEqual([{ orgId: null, reason: 'bounce' }]);
    expect(await rows('other@example.com')).toEqual([{ orgId: null, reason: 'bounce' }]);
    expect(await rows('soft@example.com')).toEqual([]);
    expect(metrics.points).toEqual([
      { event: 'email_bounced', fields: { orgId: 'org_abcdefghijk', appId: null, bytes: 2 } },
    ]);
  });

  it('suppresses complaints for the originating org, or globally without an org tag (MAIL-4.4)', async () => {
    const { post, notification, metrics } = await setup();
    await post(await notification(complaint(['angry@example.com'], 'org_abcdefghijk')));
    await post(await notification(complaint(['platform@example.com'])));
    expect(await rows('angry@example.com')).toEqual([{ orgId: 'org_abcdefghijk', reason: 'complaint' }]);
    expect(await rows('platform@example.com')).toEqual([{ orgId: null, reason: 'complaint' }]);
    expect(metrics.points.map((p) => [p.event, p.fields.orgId])).toEqual([
      ['email_complained', 'org_abcdefghijk'],
      ['email_complained', null],
    ]);
  });

  it('is idempotent for duplicate deliveries and ignores other event types (MAIL-4.6)', async () => {
    const { post, notification } = await setup();
    for (let i = 0; i < 2; i++) {
      await post(await notification(bounce('Permanent', ['dup@example.com'])));
      await post(await notification(complaint(['dup@example.com'], 'org_abcdefghijk')));
    }
    expect((await post(await notification({ eventType: 'Delivery', mail: {} }))).status).toBe(200);
    expect((await rows('dup@example.com')).sort((a, b) => String(a.orgId).localeCompare(String(b.orgId)))).toEqual([
      { orgId: null, reason: 'bounce' },
      { orgId: 'org_abcdefghijk', reason: 'complaint' },
    ]);
  });
});

describe('email_suppressions (spec 11 task 5)', () => {
  it('keeps global and org rows side by side; duplicate upserts are no-ops', async () => {
    const db = createDb(env.DB);
    const now = 1;
    for (let i = 0; i < 3; i++) {
      await suppress(db, { email: 'Both@example.com', orgId: null, reason: 'bounce', now });
      await suppress(db, { email: 'both@example.com', orgId: 'org_a', reason: 'complaint', now });
      await suppress(db, { email: 'both@example.com', orgId: 'org_b', reason: 'complaint', now });
    }
    expect(await rows('both@example.com')).toHaveLength(3);
  });
});
