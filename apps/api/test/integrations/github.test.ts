import type { PlatformError } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGitHubTokenCache, createGitHubClient, signAppJwt } from '../../src/integrations/github';

let pem = '';
let publicKey: CryptoKey;

beforeEach(async () => {
  clearGitHubTokenCache();
  if (pem) return;
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  // Stored on one line with literal "\n", like the secret.
  pem = `-----BEGIN PRIVATE KEY-----\\n${b64.match(/.{1,64}/g)?.join('\\n')}\\n-----END PRIVATE KEY-----\\n`;
});
afterEach(() => vi.restoreAllMocks());

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

describe('GitHub App auth (SRC-4.1, SRC-4.2)', () => {
  it('signs an RS256 app JWT with the documented claims', async () => {
    const now = Date.UTC(2026, 8, 27, 12);
    const jwt = await signAppJwt('12345', pem, now);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '12345' });
    const sig = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      sig,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it('uses repo-scoped installation tokens and caches them until 5 minutes before expiry', async () => {
    let now = Date.UTC(2026, 8, 27, 12);
    const tokenRequests: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/access_tokens')) {
        tokenRequests.push(init.body ? JSON.parse(String(init.body)) : null);
        return Response.json({
          token: `tok${tokenRequests.length}`,
          expires_at: new Date(now + 3_600_000).toISOString(),
        });
      }
      return Response.json({ id: 1 });
    });
    const client = createGitHubClient({
      appId: '1',
      privateKey: pem,
      installationId: '99',
      org: 'org',
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    await client.dispatchWorkflow('todo', 'deploy.yml', {});
    await client.dispatchWorkflow('todo', 'deploy.yml', {});
    expect(tokenRequests).toEqual([{ repositories: ['todo'] }]);
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok1' });

    now += 3_600_000 - 5 * 60_000 + 1; // inside the refresh margin
    await client.dispatchWorkflow('todo', 'deploy.yml', {});
    expect(tokenRequests).toHaveLength(2);
  });
});

describe('GitHub error mapping (SRC-4.3)', () => {
  const clientWith = (response: Response | Error) =>
    createGitHubClient({
      appId: '1',
      privateKey: pem,
      installationId: '99',
      org: 'org',
      fetch: (async (url: string) => {
        if (url.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: '2099-01-01T00:00:00Z' });
        if (response instanceof Error) throw response;
        return response;
      }) as unknown as typeof fetch,
    });

  it.each([
    ['5xx', new Response('', { status: 502 })],
    ['secondary rate limit', new Response('', { status: 403, headers: { 'retry-after': '30' } })],
    ['network', new TypeError('down')],
  ])('%s → UPSTREAM_ERROR', async (_, response) => {
    const error = (await clientWith(response)
      .dispatchWorkflow('r', 'deploy.yml', {})
      .catch((e) => e)) as PlatformError;
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.retryable).toBe(true);
  });

  it('includes retry_after_seconds when GitHub sends it', async () => {
    const error = (await clientWith(new Response('', { status: 403, headers: { 'retry-after': '30' } }))
      .dispatchWorkflow('r', 'deploy.yml', {})
      .catch((e) => e)) as PlatformError;
    expect(error.details).toEqual({ retry_after_seconds: 30 });
  });

  it('other 4xx → INTERNAL and logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = (await clientWith(new Response('bad', { status: 400 }))
      .dispatchWorkflow('r', 'd', {})
      .catch((e) => e)) as PlatformError;
    expect(error.code).toBe('INTERNAL');
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ message: 'github api error', status: 400 });
  });

  it('treats an empty repository as having no head', async () => {
    expect(await clientWith(new Response('{}', { status: 409 })).getHead('r')).toBeNull();
  });
});
