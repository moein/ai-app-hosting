import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { app, ROUTE_PREFIXES } from '../src/http/app';
import { listMessages, MESSAGE_TTL_SECONDS, storeMessage } from '../src/inbox';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const raw = (to: string, subject: string, body: string) =>
  [
    `From: Login <login@example.com>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

const get = (query: string, token: string | null = TOKEN) =>
  SELF.fetch(`https://inbox.test/messages${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

describe('storeMessage / listMessages', () => {
  it('parses and stores by full recipient (incl. +tag), newest first, filtered by since', async () => {
    const to = 'e2e+run1-1@example.com';
    await storeMessage(env.INBOX, { to, from: 'x@y.z', raw: raw(to, 'first', 'Code 111111'), receivedAt: 1_000 });
    await storeMessage(env.INBOX, {
      to: to.toUpperCase(),
      from: 'x@y.z',
      raw: raw(to, 'second', 'Code 222222'),
      receivedAt: 2_000,
    });
    await storeMessage(env.INBOX, {
      to: 'e2e+other@example.com',
      from: 'x@y.z',
      raw: raw(to, 'other', 'nope'),
      receivedAt: 3_000,
    });

    const all = await listMessages(env.INBOX, to, 0);
    expect(all.map((m) => m.subject)).toEqual(['second', 'first']);
    expect(all[0]).toMatchObject({ to, from: 'login@example.com', text: expect.stringContaining('222222') });
    expect((await listMessages(env.INBOX, to, 1_500)).map((m) => m.subject)).toEqual(['second']);
  });

  it('sets a 24 h expiration on stored messages', async () => {
    const before = Math.floor(Date.now() / 1000);
    await storeMessage(env.INBOX, {
      to: 'e2e+ttl@example.com',
      from: 'x@y.z',
      raw: raw('a@b.c', 's', 'b'),
      receivedAt: 5,
    });
    const { keys } = await env.INBOX.list({ prefix: 'msg:e2e+ttl@example.com:' });
    expect(keys[0]?.expiration).toBeGreaterThanOrEqual(before + MESSAGE_TTL_SECONDS - 5);
  });
});

describe('GET /messages', () => {
  it('requires the bearer token', async () => {
    expect((await get('?to=a@b.co', null)).status).toBe(401);
    const res = await get('?to=a@b.co', 'wrong-token-0123456789abcdef0123456789ab');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('validates the query', async () => {
    const res = await get('?to=not-an-email');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('lists messages for a recipient', async () => {
    const to = 'e2e+http@example.com';
    await storeMessage(env.INBOX, { to, from: 'x@y.z', raw: raw(to, 'hello', 'body'), receivedAt: Date.now() });
    const res = await get(`?to=${encodeURIComponent(to)}&since=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { subject: string }[] };
    expect(body.messages.map((m) => m.subject)).toEqual(['hello']);
  });

  it('main app only mounts route groups', () => {
    for (const route of app.routes) {
      const global = route.path === '*' || route.path === '/*';
      const mounted = ROUTE_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
      expect(global || mounted, `${route.method} ${route.path}`).toBe(true);
    }
  });
});
