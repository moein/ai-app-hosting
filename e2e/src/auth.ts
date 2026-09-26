import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect } from 'vitest';
import { extractLoginCode, waitForEmail } from './inbox';
import { callTool } from './mcp';

/** request_login_code → read the real email from the e2e inbox → the 6-digit code. */
export async function requestCode(client: Client, email: string): Promise<string> {
  const since = Date.now() - 5_000;
  const requested = await callTool(client, 'request_login_code', { email });
  expect(requested.ok, JSON.stringify(requested)).toBe(true);
  const message = await waitForEmail({
    to: email,
    since,
    timeoutMs: 120_000,
    match: (m) => /login code/i.test(m.subject),
  });
  return extractLoginCode(message);
}

/** Full login (signup for new emails) on an existing MCP session. */
export async function logIn(client: Client, email: string): Promise<{ is_new_user: boolean }> {
  const code = await requestCode(client, email);
  const verified = await callTool<{ authenticated: boolean; is_new_user: boolean }>(client, 'verify_login_code', {
    email,
    code,
  });
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  if (!verified.ok) throw new Error('login failed');
  return verified.data;
}
