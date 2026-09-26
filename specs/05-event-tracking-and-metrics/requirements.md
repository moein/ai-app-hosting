# 05 — Event Tracking & Metrics: Requirements

Every action a user takes through the MCP server is recorded as an event, sent to a Cloudflare Pipeline and stored in R2 for later analysis. Important platform metrics are written to Workers Analytics Engine for dashboards and alerting.

## Stories & acceptance criteria

### EVT-1 — Every MCP action lands in R2
As the product owner, I want a complete, queryable record of what users (via their AIs) do, so that I can understand usage, debug journeys and improve the guide.

- **EVT-1.1** WHEN any MCP tool call finishes — successfully or with any error, including `AUTH_REQUIRED`, `INVALID_INPUT` and `RATE_LIMITED` — THE SYSTEM SHALL emit exactly one `mcp_tool_call` event to the `EVENTS` pipeline.
- **EVT-1.2** WHEN an MCP session is initialized THE SYSTEM SHALL emit one `mcp_session_initialized` event including the client's `clientInfo.name`, `clientInfo.version` and protocol version, and SHALL store the client info in the session for later events.
- **EVT-1.3** THE SYSTEM SHALL include in every event the fields defined in design.md, including `event_id` (`evt_…`), `ts`, `env`, hashed session id, `user_id`, `app_id` and client info where known.
- **EVT-1.4** THE SYSTEM SHALL redact tool arguments before emitting: login `code` → `"[redacted]"`; secret `value` → `"[redacted]"`; each `write_files` file content → `{ path, bytes, sha256 }`; `email` → `email_hash` (SHA-256 of normalized email) and removed from args; `sql` truncated to 1,000 characters.
- **EVT-1.5** THE SYSTEM SHALL cap serialized (redacted) args at 8 KB, setting `args_truncated: true` when truncated.
- **EVT-1.6** THE SYSTEM SHALL emit events without delaying the tool result (via `ctx.waitUntil`), and IF emission fails THEN THE SYSTEM SHALL NOT fail the tool call, and SHALL write an `event_emit_failed` metric.
- **EVT-1.7** THE SYSTEM SHALL sink the pipeline into the `datalake-<env>` R2 bucket as an Apache Iceberg table (R2 Data Catalog) named `mcp_events`, partitioned by UTC day.
- **EVT-1.8** THE SYSTEM SHALL NOT include raw MCP session IDs, login codes, secret values or file contents in any event.

### EVT-2 — Platform metrics in Analytics Engine
As the operator, I want real-time metrics, so that I can watch growth, reliability and cost.

- **EVT-2.1** WHEN a tool call finishes THE SYSTEM SHALL write a `tool_call` data point (tool, outcome, error code, client, duration).
- **EVT-2.2** THE SYSTEM SHALL write auth data points: `login_code_requested`, `login_succeeded` (sub = `signup` | `signin`), `login_failed` (sub = error code).
- **EVT-2.3** THE SYSTEM SHALL write app data points: `app_created`, `app_deleted`, `provisioning_failed`.
- **EVT-2.4** WHEN a deployment reaches a terminal state THE SYSTEM SHALL write `deployment_finished` (sub = final status) with total, build and deploy durations and artifact size.
- **EVT-2.5** THE SYSTEM SHALL write email data points: `email_sent` (sub = `app` | `platform`), `email_rejected` (sub = reason), `email_bounced`, `email_complained`.
- **EVT-2.6** THE SYSTEM SHALL write every data point through one typed helper that enforces the blob/double/index layout in design.md, with `index1` = org ID or `anon`.
- **EVT-2.7** IF an Analytics Engine write throws THEN THE SYSTEM SHALL swallow the error and log it, never failing the caller.

## Non-functional requirements

- Event emission adds < 5 ms to tool-call latency (fire-and-forget).
- Event schema changes are additive only; breaking changes require a new table name.
- The repo keeps documented SQL for key metrics in `docs/metrics/*.sql` (DAU, signups/day, error rate by tool and client, deploy success rate, build duration p50/p95, emails/day).

## Out of scope

- Dashboards UI (use Analytics Engine SQL API / Grafana).
- Product analytics for end-users' apps (their visitors).
- Real-time alerting rules (later).
