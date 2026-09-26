# Limits

| What | Limit |
|---|---|
| Apps per account | {{MAX_APPS_PER_ORG}} |
| Deployments per day | {{MAX_DEPLOYS_PER_ORG_PER_DAY}} |
| Emails per day | {{MAX_EMAILS_PER_ORG_PER_DAY}} |
| Files per `write_files` call | {{MAX_FILES_PER_WRITE}} |
| Bytes per `write_files` call | {{bytes:MAX_WRITE_BYTES}} |
| Bytes per file | {{bytes:MAX_FILE_BYTES}} |
| File path length | {{MAX_PATH_LENGTH}} characters |
| Build artifact | {{bytes:MAX_ARTIFACT_BYTES}} |
| Worker bundle (compressed) | {{bytes:MAX_WORKER_BUNDLE_BYTES}} |
| Static asset files | {{MAX_ASSET_FILES}} files, {{bytes:MAX_ASSET_FILE_BYTES}} each |
| CPU per request | {{APP_CPU_MS_PER_REQUEST}} ms |
| Outbound requests per request | {{APP_SUBREQUESTS_PER_REQUEST}} |
| Secrets per app | {{MAX_SECRETS_PER_APP}} ({{bytes:MAX_SECRET_BYTES}} each) |
| `query_database` result | {{QUERY_MAX_ROWS}} rows / {{bytes:QUERY_MAX_BYTES}} |
| Recipients per email | {{MAX_EMAIL_RECIPIENTS}} |
| Tool calls per minute | {{TOOL_CALLS_PER_USER_PER_MINUTE}} |

When a limit is reached, tools return `QUOTA_EXCEEDED` or `RATE_LIMITED` with details; tell the user which limit it was.
