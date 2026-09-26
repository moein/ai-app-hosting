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

- `append(entries)`: insert in one transaction; per-minute counter in DO storage for LOG-2.7; if row count > `LOG_BUFFER_MAX_ENTRIES` delete oldest.
- Alarm every hour: delete `ts < now - LOG_BUFFER_MAX_AGE_MS`.
- `query(filter)`: SQL with bound params; cursor = last `seq` returned; `ORDER BY ts DESC, seq DESC LIMIT ?`.

### `get_logs` contract

```ts
in:  { app: string; since?: string; until?: string;
       level?: 'debug'|'info'|'warn'|'error'; kind?: 'request'|'console'|'exception';
       search?: string; status_min?: number; limit?: 1..200; cursor?: string }
out: { entries: (Omit<LogEntry,'ts'> & { ts: string })[]; next_cursor: string | null; next_step?: string }
```

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
