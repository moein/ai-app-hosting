import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlatformErrorJson } from '@repo/shared';
import { e2eEnv } from './env';

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: PlatformErrorJson };

/**
 * A fresh MCP session against the dev API — the same path a real AI client uses (E2E-1.3). `/mcp` is an
 * OAuth-protected resource (spec 02, AUTH-4); `accessToken` from `signIn()` is sent as a bearer token.
 */
export async function connect(accessToken: string, name = 'e2e-harness'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', e2eEnv().E2E_API_ORIGIN), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns its structured result or the PlatformError it reported. */
export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult<T>> {
  const result = await client.callTool({ name, arguments: args });
  const text = Array.isArray(result.content) ? result.content.find((part) => part.type === 'text')?.text : undefined;
  const payload = (result.structuredContent ?? (text ? JSON.parse(text) : {})) as Record<string, unknown>;
  if (result.isError) return { ok: false, error: payload.error as PlatformErrorJson };
  return { ok: true, data: payload as T };
}
