import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { PlatformError } from '@repo/shared';
import { z } from 'zod';
import { trackToolCall } from '../tracking/track';
import { runTool } from './pipeline';
import type { AnyTool, ToolContext } from './tool';

export const SERVER_INFO = { name: 'ai-app-hosting', version: '0.1.0' } as const;

type JsonSchemaObject = { type: 'object'; [key: string]: unknown };

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchemaObject => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  return { ...rest, type: 'object' };
};

export const describeTool = (tool: AnyTool): Tool => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: jsonSchema(tool.input, 'input'),
  outputSchema: jsonSchema(tool.output, 'output'),
  annotations: tool.annotations,
});

/** Low-level MCP server whose tools/list and tools/call are served by the tool registry (spec 04 design). */
export function createMcpServer(options: {
  tools: AnyTool[];
  instructions: string;
  context: () => Promise<ToolContext> | ToolContext;
}): Server {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: options.instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.tools.map(describeTool) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    const ctx = await options.context();
    if (!tool) {
      const notFound = new PlatformError('NOT_FOUND', {
        message: `Unknown tool "${request.params.name}".`,
        hint: 'Call tools/list to see the available tools.',
      });
      const error = notFound.toJSON();
      const structuredContent = { error };
      // EVT-1.1: unknown tools are tracked too (the name is capped; arguments are not recorded).
      trackToolCall(ctx, {
        tool: request.params.name.slice(0, 64),
        args: undefined,
        outcome: { ok: false, error: notFound },
        durationMs: 0,
        resultBytes: new TextEncoder().encode(JSON.stringify(structuredContent)).byteLength,
      });
      return { isError: true, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    }
    return runTool(tool, request.params.arguments, ctx);
  });

  return server;
}
