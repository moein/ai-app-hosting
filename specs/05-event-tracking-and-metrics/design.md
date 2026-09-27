# 05 — Event Tracking & Metrics: Design

## Flow

```
tool call ─▶ track middleware (first in chain, spec 04)
               ├─ after result: build McpEvent → redact → cap
               ├─ ctx.waitUntil(env.EVENTS.send([event]))            ─▶ Stream mcp-events-<env>
               │                                                        └─ Pipeline (SQL: SELECT * FROM stream)
               │                                                            └─ Sink: R2 Data Catalog table `mcp_events`
               │                                                                in bucket datalake-<env> (Iceberg, day partitions)
               └─ metrics.write('tool_call', …)                        ─▶ Analytics Engine platform_metrics_<env>
```

## Event schema (`packages/shared/src/events.ts`)

```ts
type McpEvent = {
  event_id: string;            // evt_…
  type: 'mcp_tool_call' | 'mcp_session_initialized';
  ts: number;                  // epoch ms
  env: 'dev' | 'prod';
  session_hash: string;        // hex SHA-256 of Mcp-Session-Id (never the raw id)
  user_id: string | null;
  org_id: string | null;
  app_id: string | null;       // set when the handler resolved an app (ctx.setApp)
  app_slug: string | null;
  client_name: string | null;
  client_version: string | null;
  protocol_version: string | null;
  // tool-call fields (null for session events)
  tool: string | null;
  outcome: 'ok' | 'error' | null;
  error_code: string | null;
  duration_ms: number | null;
  args_json: string | null;    // redacted, ≤ 8 KB
  args_truncated: boolean;
  result_bytes: number | null;
  email_hash: string | null;   // for pre-login funnel analysis
};
```

The stream is created with this schema (Pipelines structured stream) so malformed events are rejected at ingest rather than landing in R2.

### Where events come from (api)

- `runTool` (spec 04) is the single exit of every tool call, so it calls `trackToolCall` once per call — after the size cap, for every outcome including `AUTH_REQUIRED`, `INVALID_INPUT` and `RATE_LIMITED`. Unknown tool names (answered in `server.ts`) are tracked the same way with `error_code = NOT_FOUND`.
- `ToolContext` gains `events` (the `EVENTS` binding, optional until the stream exists — events are skipped while it is unbound), `metrics`, `waitUntil`, `client` (from the session's stored initialize request) and a mutable `app` (`{ id, slug }`) that `resolveApp` and `create_app` set so the event carries `app_id`/`app_slug`.
- `McpSession` overrides `setInitializeRequest` (called by the agents runtime for each `initialize`): it keeps the runtime's storage of the request (the client info for later events, EVT-1.2) and emits `mcp_session_initialized` plus a `session_init` metric.
- `session_hash` = hex SHA-256 of the session id; `email_hash` = hex SHA-256 of the trimmed, lower-cased email.

## Redaction rules (EVT-1.4)

A per-tool redactor map; default = pass-through.

| Tool | Field | Replacement |
|---|---|---|
| `request_login_code`, `verify_login_code` | `email` | removed; `email_hash` set |
| `verify_login_code` | `code` | `"[redacted]"` |
| `set_secret` | `value` | `"[redacted]"` |
| `write_files` | `files[].content` | removed; `files[] = { path, op, bytes, sha256 }` |
| `query_database` | `sql` | first 1,000 chars |

Then `JSON.stringify`; if > 8,192 bytes → cut to 8,192 and set `args_truncated`. A unit test enumerates the tool catalog and fails if a tool with a sensitive-looking field (`code`, `value`, `content`, `password`, `token`, `secret`) has no redactor.

## Analytics Engine layout (EVT-2.6)

Dataset `platform_metrics_<env>`. One helper: `metrics.write(event, fields)`.

| Slot | Meaning |
|---|---|
| `index1` | `org_id` or `anon` (sampling key) |
| `blob1` | event name |
| `blob2` | sub-type (tool name, status, reason, `signup`/`signin`, …) |
| `blob3` | outcome (`ok`/`error`) |
| `blob4` | error code |
| `blob5` | client name |
| `blob6` | client version |
| `blob7` | app_id |
| `blob8` | user_id |
| `double1` | count (always 1) |
| `double2` | duration_ms (total) |
| `double3` | bytes |
| `double4` | phase-1 duration (e.g. build_ms) |
| `double5` | phase-2 duration (e.g. deploy_ms) |

Event names: `tool_call`, `session_init`, `login_code_requested`, `login_succeeded`, `login_failed`, `app_created`, `app_deleted`, `provisioning_failed`, `deployment_finished`, `email_sent`, `email_rejected`, `email_bounced`, `email_complained`, `event_emit_failed`.

Workers that write: `api` (most), `email` (email_*). Both bind the same dataset as `METRICS`.

The helper lives in `packages/shared/src/metrics.ts` (`createMetrics(dataset, logger)`); a missing binding or a throwing `writeDataPoint` is logged and swallowed (EVT-2.7).

Feature metrics are written where the fact is known:

| Metric | Written by |
|---|---|
| `tool_call` | `trackToolCall` |
| `login_code_requested`, `login_succeeded`, `login_failed` | `trackToolCall`, from `request_login_code` / `verify_login_code` outcomes (`login_succeeded.sub` = `signup` when the verify output says the account was created) |
| `app_created`, `app_deleted` | `trackToolCall`, from `create_app` / `delete_app` successes |
| `provisioning_failed` | `markProvisioningFailed` (sub `app`); email worker after the last tenant retry (sub `email_tenant`) |
| `deployment_finished` | `recordDeploymentFinished(db, metrics, ids)` after every transition to `succeeded`, `failed` or `cancelled` (DeployApp, build callbacks, sweeps, redeploy, cancellations) |
| `email_sent` / `email_rejected` | email worker: `AppMail.send` (sub `app` / the error code), `PlatformMail.sendLoginCode` (sub `platform`) |
| `email_bounced`, `email_complained` | api SES webhook |

## Example metric queries (`docs/metrics/`)

```sql
-- error rate by tool and client, last 24h
SELECT blob2 AS tool, blob5 AS client,
       SUM(_sample_interval * double1) AS calls,
       SUM(IF(blob3 = 'error', _sample_interval * double1, 0)) / calls AS error_rate
FROM platform_metrics_prod
WHERE blob1 = 'tool_call' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY tool, client ORDER BY calls DESC;
```

## Retention

- Analytics Engine: platform default (3 months).
- R2 `mcp_events`: indefinite in v1 (see open questions).

## Open questions

1. R2 retention / GDPR deletion of a user's events (events are keyed by `user_id`; deletion job needed if accounts can be deleted).
2. Should deployment and email lifecycle events also go to the Pipeline (separate tables) for joinable history, not just Analytics Engine?
3. Store full `sql` for `query_database` (useful for guide improvements) vs. PII risk?
