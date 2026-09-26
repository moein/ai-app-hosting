export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadata = Record<string, unknown>;

const RESERVED = new Set(['timestamp', 'level', 'message']);
const MAX_CAUSE_DEPTH = 5;

/**
 * Structured logger (FND-9). Every call writes one JSON line with `timestamp`, `level`, `message`,
 * the logger's context and the call's metadata. Use `Logger.root` or a `child()` of it.
 */
export class Logger {
  static #root: Logger | undefined;

  /** The shared default logger, created on first access. */
  static get root(): Logger {
    Logger.#root ??= new Logger();
    return Logger.#root;
  }

  readonly #context: LogMetadata;

  constructor(context: LogMetadata = {}) {
    this.#context = context;
  }

  /** A logger whose entries also carry `context`; the parent is not changed. */
  child(context: LogMetadata): Logger {
    return new Logger({ ...this.#context, ...context });
  }

  debug(message: string, metadata?: LogMetadata): void {
    this.#write('debug', message, metadata);
  }

  info(message: string, metadata?: LogMetadata): void {
    this.#write('info', message, metadata);
  }

  warn(message: string, metadata?: LogMetadata): void {
    this.#write('warn', message, metadata);
  }

  error(message: string, metadata?: LogMetadata): void {
    this.#write('error', message, metadata);
  }

  #write(level: LogLevel, message: string, metadata: LogMetadata | undefined): void {
    try {
      const entry: LogMetadata = { timestamp: new Date().toISOString(), level, message };
      for (const [key, value] of Object.entries({ ...this.#context, ...metadata })) {
        if (!RESERVED.has(key)) entry[key] = value;
      }
      sink(level, stringify(entry));
    } catch {
      // Logging must never break the caller (FND-9.7).
    }
  }
}

function sink(level: LogLevel, line: string): void {
  // The only place in runtime code allowed to touch the console (FND-9.1).
  // biome-ignore lint/suspicious/noConsole: logger sink
  console[level](line);
}

function stringify(entry: LogMetadata): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(entry, (_key, value: unknown) => {
    if (value instanceof Error) return serializeError(value, 0);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[unserializable]';
      seen.add(value);
    }
    return value;
  });
}

function serializeError(error: Error, depth: number): LogMetadata {
  const serialized: LogMetadata = { name: error.name, message: error.message, stack: error.stack };
  if (error.cause !== undefined) {
    serialized.cause =
      error.cause instanceof Error && depth < MAX_CAUSE_DEPTH ? serializeError(error.cause, depth + 1) : error.cause;
  }
  return serialized;
}
