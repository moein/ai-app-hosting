import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { specTools } from '../src/coverage';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';

const catalog = specTools(
  readFileSync(fileURLToPath(new URL('../../specs/04-mcp-server/design.md', import.meta.url)), 'utf8'),
);
const clients: Client[] = [];

describe('MCP server', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  it(
    flow('F-MCP-1', 'initialize works without auth, returns instructions, and tools/list follows the catalog'),
    async () => {
      expect(catalog.length).toBeGreaterThan(20);
      const client = await connect();
      clients.push(client);

      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('get_platform_guide');
      expect(instructions.length).toBeLessThanOrEqual(2_000);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        const spec = catalog.find((entry) => entry.name === tool.name);
        expect(spec, `${tool.name} is not in the spec catalog`).toBeDefined();
        expect(tool.annotations).toEqual({
          readOnlyHint: spec?.flags.includes('R'),
          destructiveHint: spec?.flags.includes('D'),
          idempotentHint: spec?.flags.includes('I'),
          openWorldHint: spec?.flags.includes('O'),
        });
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.outputSchema?.type).toBe('object');
      }
    },
  );

  it(flow('F-MCP-2', 'get_platform_guide returns every topic without login'), async () => {
    const client = await connect();
    clients.push(client);
    const topics = ['all', 'workflow', 'contract', 'database', 'email', 'secrets', 'limits', 'troubleshooting'];
    for (const topic of topics) {
      const result = await callTool<{ topic: string; contract_version: string; markdown: string }>(
        client,
        'get_platform_guide',
        { topic },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.data.topic).toBe(topic);
      expect(result.data.contract_version).toBe('1');
      expect(result.data.markdown).not.toContain('{{');
    }
  });

  it(flow('F-MCP-3', 'invalid tool input returns INVALID_INPUT with issue paths'), async () => {
    const client = await connect();
    clients.push(client);
    const result = await callTool(client, 'get_platform_guide', { topic: 'recipes' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.hint.length).toBeGreaterThan(0);
    const issues = (result.error.details?.issues ?? []) as { path: string[] }[];
    expect(issues[0]?.path).toEqual(['topic']);
  });
});
