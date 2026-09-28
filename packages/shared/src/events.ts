/** One row of the `mcp_events` table (spec 05, EVT-1.3). Additive changes only. */
export type McpEvent = {
  event_id: string;
  type: 'mcp_tool_call' | 'mcp_session_initialized';
  ts: number;
  env: 'dev' | 'prod';
  session_hash: string;
  user_id: string | null;
  org_id: string | null;
  app_id: string | null;
  app_slug: string | null;
  client_name: string | null;
  client_version: string | null;
  protocol_version: string | null;
  tool: string | null;
  outcome: 'ok' | 'error' | null;
  error_code: string | null;
  duration_ms: number | null;
  args_json: string | null;
  args_truncated: boolean;
  result_bytes: number | null;
  email_hash: string | null;
};

type NullableKeys<T> = { [K in keyof T]: null extends T[K] ? K : never }[keyof T];
/** `T` with null-able fields turned into optional ones — the shape pipeline streams accept (missing = null). */
export type WithoutNulls<T> = { [K in Exclude<keyof T, NullableKeys<T>>]: T[K] } & {
  [K in NullableKeys<T>]?: Exclude<T[K], null>;
};
export type McpEventRecord = WithoutNulls<McpEvent>;

export const withoutNulls = <T extends object>(value: T): WithoutNulls<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as WithoutNulls<T>;

export type McpClientInfo = { name: string | null; version: string | null; protocolVersion: string | null };

/** Hex SHA-256 of a UTF-8 string (session ids, normalized emails — never stored raw in events, EVT-1.8). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
