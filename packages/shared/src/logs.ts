/** Runtime log entry of a user app (spec 10). Stored by the tail worker's AppLogBuffer, read by get_logs. */
export type LogKind = 'request' | 'console' | 'exception' | 'dropped';
export type AppLogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export type LogEntry = {
  ts: number;
  kind: LogKind;
  level: AppLogLevel;
  message: string;
  method?: string;
  path?: string;
  status?: number;
  outcome?: string;
  duration_ms?: number;
  stack?: string;
  invocation_id: string;
};

export type LogFilter = {
  since: number;
  until: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  kind?: 'request' | 'console' | 'exception';
  search?: string;
  status_min?: number;
  limit: number;
  cursor?: string;
};

export type LogPage = { entries: LogEntry[]; next_cursor: string | null };

/** RPC surface of the AppLogBuffer Durable Object (one per app). */
export interface AppLogsRpc {
  append(entries: LogEntry[]): Promise<void>;
  query(filter: LogFilter): Promise<LogPage>;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character, marking the cut with `…`. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const suffix = '…';
  let end = maxBytes - new TextEncoder().encode(suffix).byteLength;
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--; // don't start inside a character
  return new TextDecoder().decode(bytes.subarray(0, end)) + suffix;
}
