# 10 — Logs: Requirements

The AI needs two kinds of logs to fix problems without human help: **build logs** (why a deployment failed) and **runtime logs** (what the live app is doing: requests, console output, exceptions).

## Stories & acceptance criteria

### LOG-1 — Build logs
As an AI client, I want the relevant part of a failed build log with parsed errors, so that I can fix the code in one go.

- **LOG-1.1** WHEN a deployment failed with `BUILD_FAILED` THE SYSTEM SHALL include in `get_deployment.error` the failed `step`, a `build_log_excerpt` (last ≤ 200 lines, ≤ 20 KB, of that step's output) and parsed `errors`.
- **LOG-1.2** THE SYSTEM SHALL parse build output into at most 20 structured errors `{ kind, file?, line?, column?, code?, message }`, recognizing at least: TypeScript diagnostics (`file(l,c): error TSnnnn: …` and `file:l:c - error TSnnnn: …`), Vite/Rollup build errors (including unresolved imports), and npm install errors (`npm ERR!` / `npm error`, e.g. `ERESOLVE`, `E404`).
- **LOG-1.3** IF a failed deployment has no stored excerpt (e.g. the runner died or timed out) THEN THE SYSTEM SHALL fetch the job log from the GitHub Actions API when `get_deployment` is first called for it, store the excerpt, and return it.
- **LOG-1.4** WHEN a deployment failed with `CONTRACT_VIOLATION` THE SYSTEM SHALL return the validator's violations instead of a log excerpt.

### LOG-2 — Runtime logs
As an AI client, I want to see recent requests, console output and exceptions of the live app, so that I can debug what the user reports.

- **LOG-2.1** THE SYSTEM SHALL attach the `tail-<env>` Worker as tail consumer of every deployed app script (DEP-2.9).
- **LOG-2.2** WHEN the tail Worker receives trace events THE SYSTEM SHALL normalize each invocation into one `request` entry (`method`, `path`, `status`, `outcome`, `duration_ms`) plus one entry per console message (`level`, `message`) and per exception (`name`, `message`, `stack`).
- **LOG-2.3** THE SYSTEM SHALL NOT store request headers, cookies, query strings, request/response bodies or client IP addresses.
- **LOG-2.4** THE SYSTEM SHALL truncate each console message to 2 KB and each stack to 4 KB.
- **LOG-2.5** THE SYSTEM SHALL store entries in a per-app `AppLogBuffer` Durable Object (keyed by app ID from the script's tags), retaining at most `LOG_BUFFER_MAX_ENTRIES` entries and nothing older than `LOG_BUFFER_MAX_AGE_MS`.
- **LOG-2.6** THE SYSTEM SHALL also send every entry to the `app-logs-<env>` pipeline (R2 table `app_logs`) for archival.
- **LOG-2.7** IF an app produces more than `LOG_INGEST_MAX_PER_MINUTE` entries in a minute THEN THE SYSTEM SHALL drop further `console` entries for that minute (keeping `request` and `exception` entries) and record one `dropped` entry with the count.
- **LOG-2.8** THE SYSTEM SHALL never let the tail Worker throw; failures are logged and counted.

### LOG-3 — Querying runtime logs
As an AI client, I want to filter logs, so that I find the relevant lines quickly.

- **LOG-3.1** WHEN `get_logs({ app, since?, until?, level?, kind?, search?, status_min?, limit?, cursor? })` is called THE SYSTEM SHALL return matching entries newest first, with `next_cursor` when more exist.
- **LOG-3.2** THE SYSTEM SHALL accept `since`/`until` as ISO timestamps or relative durations (`15m`, `2h`, `1d`), default `since = 1h`.
- **LOG-3.3** THE SYSTEM SHALL filter by minimum `level` (`debug < info/log < warn < error`), `kind` (`request | console | exception`), case-insensitive substring `search` on message/path, and `status_min` for request entries.
- **LOG-3.4** THE SYSTEM SHALL cap `limit` at 200 (default 50).
- **LOG-3.5** WHEN the app has no live deployment or no entries match THE SYSTEM SHALL return an empty list with a `next_step` explaining why (not deployed yet / no traffic / widen filters).

## Non-functional requirements

- Log entries visible via `get_logs` within 10 s of the request.
- `get_logs` p95 < 500 ms.

## Out of scope

- Live tailing/streaming over MCP.
- Logs of the dispatcher/platform workers (operators use Workers Logs).
- Full build-log download (see open questions in design.md).
