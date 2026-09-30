# 17 — Scheduled Jobs: Requirements

Apps need things to happen on a schedule: a weekly digest email, a nightly cleanup, a reminder every morning. The app declares its schedules with the standard `triggers.crons` entry in `wrangler.jsonc`; the platform runs them.

Cloudflare doesn't run cron triggers for scripts in a dispatch namespace (there is no schedules API for them, and no way to call a `scheduled()` handler from outside), so the platform keeps the schedule itself and calls the app over HTTP: `POST /api/__cron` on the app, with a header the dispatcher strips from public traffic so only the platform can set it. This mirrors a `scheduled` handler: the app switches on the cron expression it receives. Times are UTC.

## Stories & acceptance criteria

### CRON-1 — Declaring schedules
As an AI client, I want to declare schedules the usual way, so that I don't learn a platform-specific format.

- **CRON-1.1** THE contract SHALL allow `triggers: { crons: string[] }` in the app's `wrangler.jsonc` (a new allowed key, CON-R11 amended); every entry SHALL be a valid 5-field cron expression (minute, hour, day of month, month, day of week; numbers, `*`, lists, ranges, steps, `JAN–DEC`/`SUN–SAT` names) and is interpreted in UTC.
- **CRON-1.2** THE validator SHALL reject (new rule `CON-R19`): more than `MAX_SCHEDULES_PER_APP` entries, invalid or duplicate expressions, and expressions that fire more often than every `CRON_MIN_INTERVAL_MINUTES` (checked over the next 24 hours of occurrences).
- **CRON-1.3** WHEN a deployment goes live THE SYSTEM SHALL read `triggers.crons` from the build output's config and replace the app's schedule set: new expressions are added (next run computed from now), removed ones deleted with their history, unchanged ones keep their state.
- **CRON-1.4** WHEN a redeploy or rollback goes live THE SYSTEM SHALL apply the schedule set of *that* artifact (CRON-1.3), so rolling back also rolls back schedules.

### CRON-2 — Running schedules
As an app owner, I want jobs to run reliably, so that reminders and digests actually go out.

- **CRON-2.1** EVERY minute THE SYSTEM SHALL start the app's run for each schedule whose next run time has come, at most `CRON_MAX_RUNS_PER_TICK` per tick (the rest run on the next tick, oldest first).
- **CRON-2.2** A run SHALL be `POST https://<slug>.APPS_DOMAIN/api/__cron` dispatched straight to the app's script (not over the public network) with the app's usual CPU and subrequest limits, header `x-platform-cron: 1`, and JSON body `{ "cron": "<expression>", "scheduled_time": <epoch ms>, "run_id": "<id>", "manual": <boolean> }`.
- **CRON-2.3** THE dispatcher SHALL remove any `x-platform-cron` header from public requests before they reach an app, so the header proves the caller is the platform.
- **CRON-2.4** A run SHALL count as `ok` for a 2xx response within `CRON_RUN_TIMEOUT_MS`; other statuses are `failed` (status recorded), no response in time is `timeout`, and a run skipped because the previous one is still in flight (started less than `CRON_RUN_TIMEOUT_MS` ago) is `skipped`.
- **CRON-2.5** THE SYSTEM SHALL NOT retry or back-fill missed runs: after a run (any outcome) the next run is the next occurrence after now; ticks missed by platform downtime are skipped.
- **CRON-2.6** WHEN a schedule has failed `CRON_PAUSE_AFTER_FAILURES` times in a row THE SYSTEM SHALL pause it (stop running, keep it listed with the reason) until a manual run succeeds or a new deployment goes live.
- **CRON-2.7** THE SYSTEM SHALL run schedules only for apps whose route is live and not deleted; deleting an app deletes its schedules.
- **CRON-2.8** THE SYSTEM SHALL keep the last `CRON_RUN_HISTORY` runs per schedule (status, HTTP status, start, duration, first `CRON_RUN_ERROR_MAX_CHARS` characters of a failing response body) and never store request or response bodies otherwise.

### CRON-3 — Operating schedules
As an AI client, I want to see and test schedules, so that I can debug a job without waiting for its time.

- **CRON-3.1** WHEN `list_schedules({ app })` is called THE SYSTEM SHALL return each schedule with its expression, next run time (ISO), state (`active`|`paused` with reason), and its last `CRON_LIST_RECENT_RUNS` runs.
- **CRON-3.2** WHEN `run_schedule({ app, cron })` is called THE SYSTEM SHALL run that schedule now (body `manual: true`), wait for the result up to `CRON_RUN_TIMEOUT_MS`, record it in the history and return the run; manual runs of the same schedule SHALL be limited to one per `CRON_MANUAL_RUN_INTERVAL_S`, and SHALL NOT move the schedule's next run time.
- **CRON-3.3** BOTH tools SHALL require a ready app of the caller; `run_schedule` for an expression the app doesn't declare returns `NOT_FOUND` listing the declared ones.
- **CRON-3.4** THE guide SHALL document the contract (declare the expression, implement `POST /api/__cron`, reject requests without `x-platform-cron`, switch on `cron`, be idempotent, finish within limits, UTC) and the fixture app SHALL exercise it.

## Non-functional requirements

- A run starts within 90 seconds of its scheduled minute under normal operation.
- The tick for 1,000 due schedules completes within one cron invocation (bounded concurrency, `CRON_MAX_RUNS_PER_TICK`).
- Runs are ordinary app invocations: they appear in `get_logs` and count in usage (`requests`, `cpu_ms`) like any request.

## Out of scope

- Sub-`CRON_MIN_INTERVAL_MINUTES` schedules, timezones other than UTC, one-off delayed jobs, retries and dead-letter queues, jobs longer than an HTTP request (apps chunk their work or use Queues later).
- Cron triggers configured outside `wrangler.jsonc`.
