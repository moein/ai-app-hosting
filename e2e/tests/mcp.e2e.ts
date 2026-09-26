import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { specTools } from '../src/coverage';
import { flow } from '../src/flows';
import { connect } from '../src/mcp';

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
});
