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

// spec 03 — organizations & apps
export const MAX_APPS_PER_ORG = 10;
export const MAX_DEPLOYS_PER_ORG_PER_DAY = 150;
export const MAX_EMAILS_PER_ORG_PER_DAY = 300;
export const CREATE_APP_WAIT_MS = 25_000;

// spec 07 — source repositories
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES_PER_WRITE = 200;
export const MAX_WRITE_BYTES = 5_000_000;
export const READ_FILE_MAX_BYTES = 80_000;
export const MAX_PATH_LENGTH = 256;

// spec 08 — build & deploy
export const MAX_ARTIFACT_BYTES = 50_000_000;
export const MAX_WORKER_BUNDLE_BYTES = 10_000_000;
export const MAX_ASSET_FILES = 5_000;
export const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
export const DEPLOY_QUEUED_TIMEOUT_MS = 15 * MINUTE_MS;
export const DEPLOY_BUILDING_TIMEOUT_MS = 20 * MINUTE_MS;
export const ARTIFACTS_RETAINED_PER_APP = 20;
export const GET_DEPLOYMENT_MAX_WAIT_S = 25;

// spec 09 — app runtime
export const APP_CPU_MS_PER_REQUEST = 100;
export const APP_SUBREQUESTS_PER_REQUEST = 50;
export const MAX_SECRET_BYTES = 5_120;
export const MAX_SECRETS_PER_APP = 50;
export const QUERY_MAX_ROWS = 200;
export const QUERY_MAX_BYTES = 80_000;

// spec 10 — logs
export const LOG_BUFFER_MAX_ENTRIES = 5_000;
export const LOG_BUFFER_MAX_AGE_MS = 7 * DAY_MS;
export const LOG_INGEST_MAX_PER_MINUTE = 3_000;
export const LOG_MESSAGE_MAX_BYTES = 2_048;
export const LOG_STACK_MAX_BYTES = 4_096;
export const BUILD_LOG_EXCERPT_MAX_LINES = 200;
export const BUILD_LOG_EXCERPT_MAX_BYTES = 20_000;

// spec 11 — email
export const MAX_EMAIL_RECIPIENTS = 50;
export const MAX_EMAIL_BYTES = 256_000;
