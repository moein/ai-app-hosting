import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { logIn, requestCode } from '../src/auth';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { testEmail } from '../src/run';

const clients: Client[] = [];
const session = async () => {
  const client = await connect();
  clients.push(client);
  return client;
};

describe('auth', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it(flow(['F-AUTH-1', 'F-AUTH-2'], 'sign up with a real emailed code, then sign in from a new session'), async () => {
    const email = testEmail('signup');
    const first = await session();
    expect((await callTool<{ authenticated: boolean }>(first, 'whoami')).ok).toBe(true);

    expect(await logIn(first, email)).toMatchObject({ is_new_user: true });
    const me = await callTool<{ authenticated: boolean; email: string }>(first, 'whoami');
    expect(me.ok && me.data).toMatchObject({ authenticated: true, email });

    // A new MCP session starts logged out; logging in again is a sign-in, not a sign-up.
    const second = await session();
    const anonymous = await callTool<{ authenticated: boolean }>(second, 'whoami');
    expect(anonymous.ok && anonymous.data.authenticated).toBe(false);
    expect(await logIn(second, email)).toMatchObject({ is_new_user: false });
  });

  it(flow('F-AUTH-3', 'wrong codes count down, and the 5th locks the code'), async () => {
    const email = testEmail('wrong-code');
    const client = await session();
    const code = await requestCode(client, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let remaining = 4; remaining >= 1; remaining--) {
      const result = await callTool(client, 'verify_login_code', { email, code: wrong });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({ code: 'CODE_INVALID', details: { attempts_remaining: remaining } });
    }
    const locked = await callTool(client, 'verify_login_code', { email, code: wrong });
    expect(!locked.ok && locked.error.code).toBe('CODE_ATTEMPTS_EXCEEDED');
    const tooLate = await callTool(client, 'verify_login_code', { email, code });
    expect(!tooLate.ok && tooLate.error.code).toBe('CODE_INVALID');
  });

  it(flow('F-AUTH-4', 'protected tools need a login, and logout ends it'), async () => {
    const client = await session();
    const anonymous = await callTool(client, 'logout');
    expect(!anonymous.ok && anonymous.error.code).toBe('AUTH_REQUIRED');
    if (!anonymous.ok) expect(anonymous.error.hint).toContain('request_login_code');

    await logIn(client, testEmail('logout'));
    const out = await callTool<{ authenticated: boolean }>(client, 'logout');
    expect(out.ok && out.data).toEqual({ authenticated: false });
    const again = await callTool(client, 'logout');
    expect(!again.ok && again.error.code).toBe('AUTH_REQUIRED');
  });

  it(flow('F-AUTH-5', 'a session can request at most 3 codes per 10 minutes'), async () => {
    const client = await session();
    for (let i = 1; i <= 3; i++) {
      const result = await callTool(client, 'request_login_code', { email: testEmail(`limit-${i}`) });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    const limited = await callTool(client, 'request_login_code', { email: testEmail('limit-4') });
    expect(!limited.ok && limited.error.code).toBe('RATE_LIMITED');
    if (!limited.ok) expect(Number(limited.error.details?.retry_after_seconds)).toBeGreaterThan(0);
  });
});
