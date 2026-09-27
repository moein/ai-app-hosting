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
  // spec 01 — slugs
  SLUG_INVALID: {
    message: "That address isn't valid.",
    hint: 'The reason is in `details.reason`. Use `details.suggestion` or ask the user for another address.',
    retryable: false,
  },
  SLUG_UNAVAILABLE: {
    message: 'That address is taken.',
    hint: 'Offer the user `details.suggestion` or ask for another address.',
    retryable: false,
  },
  // spec 02 — identity & auth
  CODE_INVALID: {
    message: 'The login code is wrong.',
    hint: 'Ask the user to re-check the latest email (`details.attempts_remaining` tries left). If 0, call `request_login_code` again.',
    retryable: false,
  },
  CODE_EXPIRED: {
    message: 'The login code has expired.',
    hint: 'Call `request_login_code` again and ask the user for the new code.',
    retryable: false,
  },
  CODE_ATTEMPTS_EXCEEDED: {
    message: 'Too many wrong login codes.',
    hint: 'Call `request_login_code` to send a new code.',
    retryable: false,
  },
  EMAIL_UNDELIVERABLE: {
    message: "We can't deliver email to this address.",
    hint: 'It bounced before. Ask the user for a different email address.',
    retryable: false,
  },
  ACCOUNT_BLOCKED: {
    message: 'This account is blocked.',
    hint: 'Tell the user to contact support.',
    retryable: false,
  },
  // spec 03 — organizations & apps
  NAME_INVALID: {
    message: 'That app name is not valid.',
    hint: 'App names must be 1–60 characters. Ask the user for a shorter or cleaner name.',
    retryable: false,
  },
  APP_NOT_READY: {
    message: 'The app is still being set up.',
    hint: 'Call get_app; if `provisioning` is "failed", call retry_provisioning, otherwise try again shortly.',
    retryable: true,
  },
  APP_DELETED: {
    message: 'This app was deleted.',
    hint: "Create a new app, or tell the user deleted apps can't be restored yet.",
    retryable: false,
  },
  // spec 07 — source repositories
  PROTECTED_PATH: {
    message: 'Some files are managed by the platform.',
    hint: '`details.paths` are managed by the platform and cannot be changed. Remove them from the request.',
    retryable: false,
  },
  FILE_TOO_LARGE: {
    message: 'A file is too large.',
    hint: '`details.path` exceeds the per-file limit. Shrink or split it; never commit build output.',
    retryable: false,
  },
  PAYLOAD_TOO_LARGE: {
    message: 'Too many files or bytes in one call.',
    hint: 'Split into several write_files calls with deploy=false, then deploy with the last one.',
    retryable: false,
  },
  COMMIT_CONFLICT: {
    message: 'The code changed since the commit you based your changes on.',
    hint: 'Re-read the affected files at `details.head_commit_sha`, reapply your changes, and retry.',
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
  SLUG_INVALID: 400,
  SLUG_UNAVAILABLE: 409,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  CODE_ATTEMPTS_EXCEEDED: 429,
  EMAIL_UNDELIVERABLE: 422,
  ACCOUNT_BLOCKED: 403,
  NAME_INVALID: 400,
  APP_NOT_READY: 409,
  APP_DELETED: 410,
  PROTECTED_PATH: 403,
  FILE_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  COMMIT_CONFLICT: 409,
} as const satisfies Record<ErrorCode, number>;

/** Rebuilds a PlatformError from its JSON form (e.g. a result returned over Workers RPC). */
export function platformErrorFromJson(json: PlatformErrorJson): PlatformError {
  return new PlatformError(json.code, {
    message: json.message,
    hint: json.hint,
    ...(json.details === undefined ? {} : { details: json.details }),
  });
}
