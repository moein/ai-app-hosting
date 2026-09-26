import { Hono } from 'hono';
import { McpSession } from '../../mcp/session';
import type { AppEnv } from '../env';

const handler = McpSession.serve('/mcp', { binding: 'MCP_SESSION' });

/** MCP over Streamable HTTP (MCP-1.1). No Authorization header is required; login happens through tools. */
export const mcpRoutes = new Hono<AppEnv>().all('/*', (c) =>
  handler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);
