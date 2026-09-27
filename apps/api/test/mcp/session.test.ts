import { SELF } from 'cloudflare:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';

const clients: Client[] = [];

async function connect() {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://api.test/mcp'), {
    fetch: (input, init) => SELF.fetch(input, init),
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
    for (const tool of [
      'get_platform_guide',
      'request_login_code',
      'verify_login_code',
      'write_files',
      'get_deployment',
    ]) {
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
