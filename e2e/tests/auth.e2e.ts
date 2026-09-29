import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { LOGIN_CODE_MAX_ATTEMPTS, LOGIN_CODES_PER_SIGN_IN } from '@repo/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  exchangeToken,
  extractError,
  getAuthorizePage,
  pkcePair,
  postAuthorizeForm,
  registerClient,
  signIn,
} from '../src/auth';
import { e2eEnv } from '../src/env';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { testEmail } from '../src/run';

const clients: Client[] = [];
const session = async (accessToken: string) => {
  const client = await connect(accessToken);
  clients.push(client);
  return client;
};

describe('auth', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it(
    flow('F-AUTH-1', 'sign up through OAuth: register a client, the sign-in page, a real emailed code, token, whoami'),
    async () => {
      const email = testEmail('signup');
      const tokens = await signIn(email);
      const client = await session(tokens.accessToken);
      const me = await callTool<{ email: string }>(client, 'whoami');
      expect(me.ok && me.data).toMatchObject({ email });
    },
  );

  it(flow('F-AUTH-2', 'a second client signs in as the same user; the refresh token rotates'), async () => {
    const email = testEmail('second-client');
    const first = await signIn(email);
    const firstClient = await session(first.accessToken);
    const meFirst = await callTool<{ email: string }>(firstClient, 'whoami');
    expect(meFirst.ok && meFirst.data.email).toBe(email);

    const second = await signIn(email);
    const secondClient = await session(second.accessToken);
    const meSecond = await callTool<{ email: string }>(secondClient, 'whoami');
    expect(meSecond.ok && meSecond.data.email).toBe(email);

    const refreshed = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: second.refreshToken,
      client_id: second.clientId,
    });
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(second.accessToken);
    expect(refreshed.refresh_token).not.toBe(second.refreshToken);
  });

  it(flow('F-AUTH-3', `wrong codes count down, and the ${LOGIN_CODE_MAX_ATTEMPTS}th locks the code`), async () => {
    const email = testEmail('wrong-code');
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const pendingId = await getAuthorizePage(clientId, challenge, crypto.randomUUID());
    const emailRes = await postAuthorizeForm('/authorize/email', { pending: pendingId, email });
    expect(emailRes.status).toBe(200);

    // A wrong code is never the right one; "000000" collides with the real one at negligible odds.
    for (let remaining = LOGIN_CODE_MAX_ATTEMPTS - 1; remaining >= 1; remaining--) {
      const res = await postAuthorizeForm('/authorize/code', { pending: pendingId, code: '000000' });
      expect(res.status).toBe(400);
      expect(extractError(await res.text())).toContain(`${remaining} ${remaining === 1 ? 'try' : 'tries'} left`);
    }
    const locked = await postAuthorizeForm('/authorize/code', { pending: pendingId, code: '000000' });
    expect(locked.status).toBe(400);
    expect(extractError(await locked.text())).toMatch(/send a new one/i);
  });

  it(
    flow(
      'F-AUTH-4',
      '/mcp without or with an invalid token → 401 with resource_metadata; both metadata documents are served',
    ),
    async () => {
      const { E2E_API_ORIGIN } = e2eEnv();
      const noToken = await fetch(new URL('/mcp', E2E_API_ORIGIN));
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get('www-authenticate') ?? '').toContain('resource_metadata');

      const badToken = await fetch(new URL('/mcp', E2E_API_ORIGIN), {
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(badToken.status).toBe(401);
      expect(badToken.headers.get('www-authenticate') ?? '').toContain('resource_metadata');

      const resourceMeta = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', E2E_API_ORIGIN));
      expect(resourceMeta.status).toBe(200);
      const authServerMeta = await fetch(new URL('/.well-known/oauth-authorization-server', E2E_API_ORIGIN));
      expect(authServerMeta.status).toBe(200);
    },
  );

  it(flow('F-AUTH-5', 'a sign-in can request at most a few codes; a post from another origin is refused'), async () => {
    const email = testEmail('code-limit');
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const pendingId = await getAuthorizePage(clientId, challenge, crypto.randomUUID());
    for (let i = 0; i < LOGIN_CODES_PER_SIGN_IN; i++) {
      const res = await postAuthorizeForm('/authorize/email', { pending: pendingId, email });
      expect(res.status, `code ${i + 1}`).toBe(200);
    }
    const limited = await postAuthorizeForm('/authorize/email', { pending: pendingId, email });
    expect(limited.status).toBe(429);
    expect(extractError(await limited.text())).toMatch(/too many codes/i);

    const { E2E_API_ORIGIN } = e2eEnv();
    const foreignOrigin = await fetch(new URL('/authorize/email', E2E_API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: new URLSearchParams({ pending: pendingId, email }).toString(),
    });
    expect(foreignOrigin.status).toBe(403);
  });
});
