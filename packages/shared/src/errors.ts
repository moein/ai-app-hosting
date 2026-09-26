type CatalogEntry = { message: string; hint: string; retryable: boolean };

/** Every error code the platform can return (FND-4.1). Feature specs append their codes here. */
export const ERROR_CATALOG = {
  INTERNAL: {
    message: 'Something went wrong on our side.',
    hint: 'Try again; if it keeps failing, tell the user.',
    retryable: true,
  },
  INVALID_INPUT: {
    message: 'The request is invalid.',
    hint: 'Fix the fields listed in `details.issues` and call again.',
    retryable: false,
  },
  AUTH_REQUIRED: {
    message: 'You need to log in first.',
    hint: 'Ask the user for their email address, then call `request_login_code`.',
    retryable: false,
  },
  RATE_LIMITED: {
    message: 'Too many requests.',
    hint: 'Wait `details.retry_after_seconds` seconds before retrying.',
    retryable: true,
  },
  NOT_FOUND: {
    message: 'Not found.',
    hint: 'Check the identifier; use the matching `list_*` tool to find valid values.',
    retryable: false,
  },
  QUOTA_EXCEEDED: {
    message: 'A usage limit was reached.',
    hint: 'Tell the user which limit was reached (`details.limit`).',
    retryable: false,
  },
  CONFLICT: {
    message: 'The state changed while handling the request.',
    hint: 'Re-read the current state and retry.',
    retryable: true,
  },
  UPSTREAM_ERROR: {
    message: 'A provider the platform depends on failed.',
    hint: 'Retry shortly.',
    retryable: true,
  },
} as const satisfies Record<string, CatalogEntry>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type PlatformErrorJson = {
  code: ErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    options: { message?: string; hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    const entry = ERROR_CATALOG[code];
    super(options.message ?? entry.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PlatformError';
    this.code = code;
    this.hint = options.hint ?? entry.hint;
    this.retryable = entry.retryable;
    this.details = options.details;
  }

  /** The caller-facing shape. Never includes the stack or the cause (FND-4.2). */
  toJSON(): PlatformErrorJson {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** Converts anything thrown into a PlatformError; unknown errors become a generic INTERNAL (FND-4.2). */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError('INTERNAL', { cause: error });
}

/** HTTP status used when a PlatformError is returned from an HTTP route (MCP tools return errors as tool results). */
export const ERROR_HTTP_STATUS = {
  INTERNAL: 500,
  INVALID_INPUT: 400,
  AUTH_REQUIRED: 401,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  QUOTA_EXCEEDED: 429,
  CONFLICT: 409,
  UPSTREAM_ERROR: 502,
} as const satisfies Record<ErrorCode, number>;
