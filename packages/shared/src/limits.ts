/**
 * All numeric limits, quotas and timeouts. Specs refer to these by name; guide text interpolates them.
 * Feature specs append their constants here.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// spec 02 — identity & auth
export const LOGIN_CODE_TTL_MS = 10 * MINUTE_MS;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODES_PER_EMAIL_PER_HOUR = 5;
export const LOGIN_CODES_PER_EMAIL_PER_DAY = 20;
export const LOGIN_CODES_PER_SESSION_PER_10_MIN = 3;
export const SESSION_IDLE_TTL_MS = 30 * DAY_MS;

// spec 04 — MCP server
export const TOOL_CALLS_PER_USER_PER_MINUTE = 120;
export const TOOL_RESULT_MAX_BYTES = 100_000;
export const TOOL_MAX_DURATION_MS = 30_000;
