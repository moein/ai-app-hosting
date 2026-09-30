# 17 — Scheduled Jobs: Design

## Flow

```
api worker  cron "* * * * *"  ──▶ runDueSchedules(now)
   D1 app_schedules WHERE state='active' AND next_run_at <= now ORDER BY next_run_at LIMIT CRON_MAX_RUNS_PER_TICK
   for each (bounded concurrency 10):
     claim:  UPDATE app_schedules SET next_run_at = next(cron, now), running_since = now
             WHERE id = ? AND next_run_at = ? AND (running_since IS NULL OR running_since < now - TIMEOUT) RETURNING …
     env.DISPATCHER.get(scriptName, {}, { limits }).fetch(POST https://<slug>.<APPS_DOMAIN>/api/__cron, x-platform-cron: 1)
     record schedule_runs; clear running_since; update failure streak / pause
deploy "activate" step ──▶ syncSchedules(appId, crons)      (spec 08 integration)
dispatcher ──▶ strips x-platform-cron from every public request                                   (CRON-2.3)
```

The api worker gains a `dispatch_namespaces` binding (`DISPATCHER` → `apps-<env>`), the same as the dispatcher's, and a fourth cron trigger `* * * * *` (existing: `0 3`, `0 *`, `*/5`). `scheduled` handler dispatches by `controller.cron` as it does today.

## Data model

```sql
CREATE TABLE app_schedules (
  id              TEXT PRIMARY KEY,               -- sch_<nanoid(11)>
  app_id          TEXT NOT NULL REFERENCES apps(id),
  cron            TEXT NOT NULL,                  -- canonical expression (trimmed, single spaces)
  next_run_at     INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused'
  paused_reason   TEXT,
  failure_streak  INTEGER NOT NULL DEFAULT 0,
  running_since   INTEGER,
  last_manual_at  INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (app_id, cron)
);
CREATE INDEX app_schedules_due ON app_schedules (state, next_run_at);

CREATE TABLE schedule_runs (
  id            TEXT PRIMARY KEY,                 -- run_<nanoid(11)>
  schedule_id   TEXT NOT NULL REFERENCES app_schedules(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  duration_ms   INTEGER,
  status        TEXT NOT NULL,                    -- 'ok' | 'failed' | 'timeout' | 'skipped'
  http_status   INTEGER,
  manual        INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX schedule_runs_schedule ON schedule_runs (schedule_id, started_at DESC);
```

`newId('sch')` and `newId('run')` join the id prefixes. Runs beyond `CRON_RUN_HISTORY` per schedule are deleted right after inserting a new one; `ON DELETE CASCADE` needs `PRAGMA foreign_keys` — D1 enforces foreign keys, so the delete of a schedule removes its runs.

## Cron expressions (`packages/app-contract/src/cron.ts`, zero dependencies)

Shared by the validator (bundled into the CLI) and the api:

```ts
parseCron(expression: string): { ok: true; cron: ParsedCron; canonical: string } | { ok: false; reason: string };
nextRun(cron: ParsedCron, afterMs: number): number;          // next matching minute strictly after, UTC; ≤ 5 years ahead or throws
occurrences(cron: ParsedCron, fromMs: number, count: number): number[];
```

Standard semantics including "day of month OR day of week when both are restricted" (Vixie cron). Not supported (rejected with a clear reason): `@daily`-style aliases, `?`, `L`, `W`, `#`, seconds, 6/7-field forms. `CRON-R19` uses `occurrences` over 24 h to compute the smallest gap.

## Deploy integration (`apps/api/src/builds/deploy.ts`)

`inspectArtifact` reads `triggers.crons` from `dist/app/wrangler.json` into `Artifact.config.crons` (task 1 verifies the Vite plugin emits it; if it doesn't, the build script step copies it from the app's `wrangler.jsonc`, which is in the artifact's source snapshot). In the `activate` step after the route is written: `syncSchedules(db, appId, crons, now)`:

```
existing = schedules of app; wanted = canonical(crons)
delete existing not in wanted; insert new (next_run_at = nextRun(now)); state/streak of kept ones reset to active/0 (new deployment un-pauses, CRON-2.6)
```

`delete_app` deletes the app's schedules in its batch (CRON-2.7). The reconcile cron treats a not-live app's schedules as dormant (the due query joins `apps.status='active'` and live deployment).

## Run (`apps/api/src/schedules/run.ts`)

```ts
runSchedule(deps, schedule, { manual, scheduledFor }): Promise<RunResult>
```

Builds the request, races `fetch` against `CRON_RUN_TIMEOUT_MS` (AbortController), maps the outcome (CRON-2.4), truncates a failing body, inserts the run, applies streak/pause rules. Manual runs do not touch `next_run_at`/streak except a successful manual run un-pauses (CRON-2.6). The `run_id` is passed to the app so its own logs can correlate.

## Dispatcher (`apps/dispatcher/src/route.ts`)

Before dispatching a public request: `request.headers.delete('x-platform-cron')` (on the header copy that `isolateRequest` already builds). Tested in `route.test.ts`; the e2e fixture proves a public request with the header is treated as anonymous (it echoes whether the header was present).

## Tools (`apps/api/src/tools/schedules/`)

```
list_schedules  in { app }                 out { schedules: { cron; next_run_at; state; paused_reason?; recent_runs: { id; status; http_status; started_at; duration_ms; manual; error? }[] }[] }
run_schedule    in { app; cron }           out { run: { id; status; http_status; duration_ms; error? }; next_step }
```

Annotations: `list_schedules` `{ readOnly, idempotent }`; `run_schedule` `{ }` (runs app code with side effects; not destructive/idempotent). Titles: "List scheduled jobs", "Run a scheduled job now".

## Contract and guide

- `ALLOWED_WRANGLER_KEYS` gains `triggers`; validator checks its shape (`crons` array of strings only; any other `triggers` key → CON-R11) and CRON-1.2 (`CON-R19`, added to `rules.ts` with its `fix`).
- `guide/schedules.md` (new topic after `storage`): declare, handler recipe, security check, idempotency, UTC, limits, and "runs appear in get_logs".

```ts
app.post('/api/__cron', async (c) => {
  if (!c.req.header('x-platform-cron')) return c.text('forbidden', 403);   // only the platform can send this header
  const { cron } = await c.req.json();
  if (cron === '0 9 * * *') await sendDigest(c.env);
  return c.json({ ok: true });
});
```

Note the path: the app's `assets.run_worker_first` only covers `/api/*`, so the route must live under `/api/`.

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `MAX_SCHEDULES_PER_APP` | 5 |
| `CRON_MIN_INTERVAL_MINUTES` | 5 |
| `CRON_MAX_RUNS_PER_TICK` | 200 |
| `CRON_RUN_TIMEOUT_MS` | 30_000 |
| `CRON_PAUSE_AFTER_FAILURES` | 10 |
| `CRON_RUN_HISTORY` | 20 |
| `CRON_LIST_RECENT_RUNS` | 5 |
| `CRON_RUN_ERROR_MAX_CHARS` | 500 |
| `CRON_MANUAL_RUN_INTERVAL_S` | 60 |

## Usage and metrics

Runs are app invocations; the tail worker already counts them (`requests`, `cpu_ms`). The tick writes `schedule_run` metrics (spec 05: `blob2` status) and `schedule_tick` (runs started, duration).

## Security notes

- Only the platform can send `x-platform-cron`, provided the dispatcher strips it (tested) and apps are only reachable through the dispatcher (they have no other route, RUN-2.5).
- An app that forgets the header check exposes its job endpoint to the public. The guide stresses the check; detecting it automatically is an open question below.
- Runs use the app's normal CPU/subrequest limits, so a runaway job can't exceed a request's budget.

## Open questions

1. A validator or e2e probe that flags apps whose `/api/__cron` answers 2xx without the header.
2. Longer jobs via Queues consumers (a later contract version).
3. Per-schedule enable/disable tool.
