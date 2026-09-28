import {
  type AppLogLevel,
  type Invocation,
  LOG_MESSAGE_MAX_BYTES,
  LOG_STACK_MAX_BYTES,
  type LogEntry,
  truncateUtf8,
} from '@repo/shared';

const LEVELS: ReadonlySet<string> = new Set<AppLogLevel>(['debug', 'log', 'info', 'warn', 'error']);

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const isFetch = (event: TraceItem['event']): event is TraceItemFetchEventInfo =>
  !!event && 'request' in event && typeof (event as TraceItemFetchEventInfo).request?.url === 'string';

function pathOf(url: string): string {
  try {
    return new URL(url).pathname; // no host, no query string (LOG-2.3)
  } catch {
    return '/';
  }
}

/** Turns one trace item into log entries (LOG-2.2–2.4). Keeps no headers, query strings, bodies or IPs. */
export function normalize(
  item: TraceItem,
  now = Date.now(),
): { appId: string | null; entries: LogEntry[]; invocation: Invocation } {
  const appId = item.scriptTags?.find((tag) => tag.startsWith('app_')) ?? null;
  const invocation_id = crypto.randomUUID();
  const ts = item.eventTimestamp ?? item.logs[0]?.timestamp ?? item.exceptions[0]?.timestamp ?? now;
  const entries: LogEntry[] = [];

  if (isFetch(item.event)) {
    const { method } = item.event.request;
    const path = pathOf(item.event.request.url);
    const status = item.event.response?.status;
    const failed = (status !== undefined && status >= 500) || item.outcome !== 'ok';
    entries.push({
      ts,
      kind: 'request',
      level: failed ? 'error' : 'info',
      message: `${method} ${path} ${status ?? item.outcome}`,
      method,
      path,
      ...(status === undefined ? {} : { status }),
      outcome: item.outcome,
      duration_ms: Math.round(item.wallTime ?? 0),
      invocation_id,
    });
  }
  for (const log of item.logs) {
    const args: unknown[] = Array.isArray(log.message) ? log.message : [log.message];
    entries.push({
      ts: log.timestamp,
      kind: 'console',
      level: LEVELS.has(log.level) ? (log.level as AppLogLevel) : 'log',
      message: truncateUtf8(args.map(stringify).join(' '), LOG_MESSAGE_MAX_BYTES),
      invocation_id,
    });
  }
  for (const exception of item.exceptions) {
    entries.push({
      ts: exception.timestamp,
      kind: 'exception',
      level: 'error',
      message: truncateUtf8(`${exception.name}: ${exception.message}`, LOG_MESSAGE_MAX_BYTES),
      ...(exception.stack ? { stack: truncateUtf8(exception.stack, LOG_STACK_MAX_BYTES) } : {}),
      invocation_id,
    });
  }
  // spec 13: every trace event is one invocation of the app, with its exact CPU time.
  return { appId, entries, invocation: { ts, cpuMs: item.cpuTime ?? 0 } };
}
