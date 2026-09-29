import { createExecutionContext, env } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { McpSession } from '../../src/mcp/session';

const clients: Client[] = [];
// Talks to the McpSession Durable Object directly, bypassing the OAuthProvider gate in front of /mcp in
// production (spec 02, AUTH-4): these tests exercise MCP session mechanics, not the OAuth flow (test/oauth/*).
const handler = McpSession.serve('/mcp', { binding: 'MCP_SESSION' });

async function connect() {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://api.test/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init), env as Env, createExecutionContext()),
  });
  // The SDK's transport types don't satisfy exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Transport);
  clients.push(client);
  return { client, transport };
}

describe('MCP endpoint (MCP-1.1)', () => {
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it('accepts initialize without an Authorization header and assigns a session id', async () => {
    const { client, transport } = await connect();
    expect(transport.sessionId).toBeTruthy();
    expect(client.getServerVersion()).toMatchObject({ name: 'ai-app-hosting' });
    expect(client.getServerCapabilities()).toHaveProperty('tools');
  });

  it('returns the server instructions (MCP-2.1)', async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.length).toBeLessThanOrEqual(2_000);
    for (const tool of ['get_platform_guide', 'whoami', 'write_files', 'get_deployment']) {
      expect(instructions).toContain(tool);
    }
    expect(instructions).toContain('motad.app');
  });

  it('serves tools/list on the session', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(Array.isArray(tools)).toBe(true);
  });

  it('unknown tools return a NOT_FOUND tool error', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('gives separate sessions separate ids', async () => {
    const a = await connect();
    const b = await connect();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
  });
});
