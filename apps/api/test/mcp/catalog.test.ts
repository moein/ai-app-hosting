import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG, TOOLS_LIST_MAX_CHARS } from '../../src/mcp/catalog';
import { TOOLS } from '../../src/mcp/registry';
import { describeTool } from '../../src/mcp/server';

const VENDOR_NAMES = /claude|chatgpt|openai|anthropic|gemini|copilot/i;

const keysDeep = (value: unknown): string[] =>
  value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]) : [];

describe('tool catalog conformance (MCP-3.1, MCP-1.4, MCP-1.5, MCP-1.6)', () => {
  it('registers each tool once, and only tools from the catalog', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(TOOL_CATALOG, `"${name}" is not in the catalog`).toHaveProperty(name);
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s matches its catalog entry', (name, tool) => {
    const entry = TOOL_CATALOG[name];
    expect(tool.title).toBe(entry?.title);
    expect(tool.annotations).toEqual(entry?.annotations);
  });

  it('tool names are snake_case and descriptions are client-agnostic', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description).not.toMatch(VENDOR_NAMES);
    }
  });

  it('no tool exposes organization fields in its schemas', () => {
    for (const tool of TOOLS) {
      const { inputSchema, outputSchema } = describeTool(tool);
      const orgKeys = keysDeep({ inputSchema, outputSchema }).filter((key) => /^org(_|Id|anization|$)/i.test(key));
      expect(orgKeys, tool.name).toEqual([]);
    }
  });

  it('tools/list stays within the context budget', () => {
    expect(JSON.stringify(TOOLS.map(describeTool)).length).toBeLessThanOrEqual(TOOLS_LIST_MAX_CHARS);
  });
});
