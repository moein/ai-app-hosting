import type { PlatformError } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResendClient, type ResendEmail } from '../src/integrations/resend';

const email: ResendEmail = {
  from: 'Login <login@x.test>',
  to: ['a@b.co'],
  subject: 's',
  text: 't',
  html: 'h',
  tags: [],
};

const failWith = async (response: Response | Error) => {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  try {
    await createResendClient('key', fetchImpl as typeof fetch).send(email, { idempotencyKey: 'k' });
  } catch (error) {
    return error as PlatformError;
  }
  throw new Error('expected send to fail');
};

describe('ResendClient (MAIL-3.3, MAIL-3.4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the email with auth and idempotency headers and returns the id', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'msg_1' }));
    const result = await createResendClient('re_key', fetchImpl as typeof fetch).send(email, {
      idempotencyKey: 'login-code/lc_1',
    });
    expect(result).toEqual({ id: 'msg_1' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer re_key', 'idempotency-key': 'login-code/lc_1' });
    expect(JSON.parse(String(init.body))).toEqual(email);
  });

  it('429 → UPSTREAM_ERROR with retry_after_seconds', async () => {
    const error = await failWith(new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.details).toEqual({ retry_after_seconds: 7 });
  });

  it('5xx and network failures → UPSTREAM_ERROR', async () => {
    expect((await failWith(new Response('oops', { status: 503 }))).code).toBe('UPSTREAM_ERROR');
    expect((await failWith(new TypeError('network down'))).code).toBe('UPSTREAM_ERROR');
  });

  it('other 4xx (bad key, unverified domain) → INTERNAL and logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await failWith(new Response('{"message":"invalid api key"}', { status: 401 }))).code).toBe('INTERNAL');
    expect((await failWith(new Response('{"message":"domain not verified"}', { status: 422 }))).code).toBe('INTERNAL');
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      message: 'resend rejected the request',
      status: 422,
    });
  });
});
