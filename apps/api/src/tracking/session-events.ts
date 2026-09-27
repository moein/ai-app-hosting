import { type McpClientInfo, type McpEvent, newId, sha256Hex } from '@repo/shared';

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null);

/** Client info from a stored MCP `initialize` request (EVT-1.2). */
export function clientInfoFrom(request: unknown): McpClientInfo | null {
  const params = (request as { params?: { protocolVersion?: unknown; clientInfo?: Record<string, unknown> } })?.params;
  if (!params) return null;
  return {
    name: str(params.clientInfo?.name),
    version: str(params.clientInfo?.version),
    protocolVersion: str(params.protocolVersion),
  };
}

export async function sessionInitializedEvent(options: {
  sessionId: string;
  env: 'dev' | 'prod';
  now: number;
  client: McpClientInfo | null;
}): Promise<McpEvent> {
  return {
    event_id: newId('evt'),
    type: 'mcp_session_initialized',
    ts: options.now,
    env: options.env,
    session_hash: await sha256Hex(options.sessionId),
    user_id: null,
    org_id: null,
    app_id: null,
    app_slug: null,
    client_name: options.client?.name ?? null,
    client_version: options.client?.version ?? null,
    protocol_version: options.client?.protocolVersion ?? null,
    tool: null,
    outcome: null,
    error_code: null,
    duration_ms: null,
    args_json: null,
    args_truncated: false,
    result_bytes: null,
    email_hash: null,
  };
}
