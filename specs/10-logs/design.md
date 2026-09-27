# 10 — Logs: Design

## Build logs

Sources, in priority order:
1. **Fail callback** (DEP-1.4): `{ step, log_tail }` stored in `deployments.error_details`.
2. **GitHub API fallback** (LOG-1.3): `GitHubClient.getJobLog(repo, job_id)` (`GET /repos/{o}/{r}/actions/jobs/{job_id}/logs`, plain text); find the last failed step section (`##[group]Run …` markers / `##[error]`), take its last 200 lines, strip ANSI + timestamps, save to `error_details`.

### Error parser (`apps/api/src/logs/build-errors.ts`)

Pure function `parseBuildErrors(text) → BuildError[]` (max 20, de-duplicated):

```ts
type BuildError = { kind: 'typescript' | 'bundler' | 'npm' | 'other';
                    file?: string; line?: number; column?: number; code?: string; message: string };
```

| Kind | Patterns (examples) |
|---|---|
| typescript | `src/api/index.ts(12,5): error TS2304: Cannot find name 'x'.` / `src/web/App.tsx:3:10 - error TS2307: …` |
| bundler | `[vite]: Rollup failed to resolve import "x" from "src/web/App.tsx"` / `error during build:` + following `file:line:col` / esbuild `✘ [ERROR] …` with location line |
| npm | `npm ERR! code ERESOLVE`, `npm error 404 Not Found - GET https://registry.npmjs.org/<pkg>` |
| other | last `Error:` line if nothing else matched |

File paths are normalized relative to the repo root (strip `/home/runner/work/<repo>/<repo>/`).

## Runtime logs

```
app script (dispatch namespace) ──trace events──▶ tail-<env> Worker (tail handler)
                                                    ├─ normalize + truncate + rate-limit per app
                                                    ├─ APP_LOGS DO (idFromName(appId)).append(entries)   ── RPC
                                                    └─ ctx.waitUntil(env.LOG_ARCHIVE.send(entries))      ── pipeline app-logs-<env>
apps/api get_logs ──RPC──▶ APP_LOGS DO (bound via script_name: "tail-<env>")
```

`appId` comes from `TraceItem.scriptTags` (scripts are tagged `[app_id, org_id]` at upload, DEP-2.9).

### Entry schema

```ts
type LogEntry = {
  ts: number;
  kind: 'request' | 'console' | 'exception' | 'dropped';
  level: 'debug' | 'log' | 'info' | 'warn' | 'error';     // request: 'error' if status ≥ 500 or outcome ≠ ok, else 'info'
  message: string;                                         // console args joined; exception "Name: message"; request "GET /api/x 500"
  method?: string; path?: string; status?: number;
  outcome?: string;                                        // TraceItem.outcome: ok | exception | exceededCpu | exceededMemory | canceled | …
  duration_ms?: number;
  stack?: string;
  invocation_id: string;                                   // groups a request with its console/exception lines
};
```

`path` = `new URL(url).pathname` (no host, no query — LOG-2.3).

### `AppLogBuffer` Durable Object (SQLite-backed, in `apps/tail`)

```sql
CREATE TABLE logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
  method TEXT, path TEXT, status INTEGER, outcome TEXT, duration_ms INTEGER, stack TEXT,
  invocation_id TEXT NOT NULL
);
CREATE INDEX logs_ts ON logs (ts DESC);
```

- `append(entries)`: insert in one transaction; per-minute counter (table `ingest(minute, count, dropped_seq)`, minute = `floor(entry.ts / 60 000)`) for LOG-2.7 — once a minute has `LOG_INGEST_MAX_PER_MINUTE` entries its further `console` entries are dropped and a single `dropped` entry (level `warn`) for that minute is inserted, then updated with the running count; if row count > `LOG_BUFFER_MAX_ENTRIES` delete oldest (by `seq`).
- `purge()`: deletes all storage and the alarm (dev e2e purge, spec 12 E2E-4.2).
- Alarm every hour (set on first append): delete `ts < now - LOG_BUFFER_MAX_AGE_MS` and old `ingest` rows.
- `query(filter)`: SQL with bound params; `ORDER BY ts DESC, seq DESC LIMIT limit + 1`; cursor = `"<ts>.<seq>"` of the last entry returned (opaque to the AI), next page = rows strictly after it in that order.
- Level filter: rank `debug`=0, `log`/`info`=1, `warn`=2, `error`=3; `level` keeps entries with rank ≥ the given one. `search` is a case-insensitive substring (`instr`, no wildcards) of `message` or `path`. `status_min` keeps only `request` entries with `status ≥ status_min`.

The shared types (`LogEntry`, `LogFilter`, `LogPage`, `AppLogsRpc`) live in `packages/shared/src/logs.ts`; the api binds the DO as `APP_LOGS` with `script_name: "tail-<env>"` (so `tail-<env>` must be deployed first) and reaches it through `ToolContext.appLogs`.

### Tail Worker normalization (`apps/tail/src/normalize.ts`)

- `appId` = the `scriptTags` entry starting with `app_`; items without one are ignored (logged).
- `invocation_id` = a random UUID per `TraceItem`.
- Request entry only for `fetch` events; `duration_ms` = `TraceItem.wallTime`; `ts` = `eventTimestamp` (or the first log/exception timestamp, or now).
- Console `message` = args joined by a space (strings as-is, everything else `JSON.stringify`, unserializable → `String()`); unknown levels become `log`.
- Truncation is by UTF-8 bytes, never splitting a character, with a `…` suffix.
- The tail handler catches everything (LOG-2.8): one failing item or DO call is logged and doesn't affect the others.

### Archival (LOG-2.6)

`LOG_ARCHIVE` is a Pipelines binding to the `app-logs-<env>` stream; every entry is sent as `{ app_id, ...entry }` in `ctx.waitUntil`, after (and independent of) the DO write. The binding is optional in code: until R2 is enabled on the account (the pipeline's sink), `wrangler.jsonc` doesn't declare it and archival is skipped.

### `get_logs` contract

```ts
in:  { app: string; since?: string; until?: string;
       level?: 'debug'|'info'|'warn'|'error'; kind?: 'request'|'console'|'exception';
       search?: string; status_min?: number; limit?: 1..200; cursor?: string }
out: { entries: (Omit<LogEntry,'ts'> & { ts: string })[]; next_cursor: string | null; next_step?: string }
```

`limit` above 200 is clamped to 200 (LOG-3.4). A `since`/`until` that is neither ISO 8601 nor `<n>m|h|d` → `INVALID_INPUT`. The window is `since ≤ ts < until` (default `until` = now).

## Limits

| Constant | Value |
|---|---|
| `LOG_BUFFER_MAX_ENTRIES` | 5_000 |
| `LOG_BUFFER_MAX_AGE_MS` | 7 days |
| `LOG_INGEST_MAX_PER_MINUTE` | 3_000 |
| `LOG_MESSAGE_MAX_BYTES` | 2_048 |
| `LOG_STACK_MAX_BYTES` | 4_096 |
| `BUILD_LOG_EXCERPT_MAX_LINES` | 200 |
| `BUILD_LOG_EXCERPT_MAX_BYTES` | 20_000 |

## Open questions

1. Add `get_build_log({ app, deployment, offset })` for the full log if excerpts prove insufficient.
2. Should apps be allowed to log query strings (useful for debugging) with a per-app opt-in?
3. Archive retention for `app_logs` in R2 (e.g. 30 days) and deletion on app purge.
