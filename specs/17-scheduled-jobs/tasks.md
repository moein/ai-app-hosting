# 17 — Scheduled Jobs: Tasks

Depends on: 06 (validator, guide), 08 (deploy activate step), 09 (dispatcher), 12 (e2e).

- [ ] **1. Cron parser + `CON-R19` + allowed `triggers` key**
  `cron.ts` (parse, canonical, nextRun, occurrences), validator rule, `rules.ts` entry, guide rule table, rebuild validator bundle. First, verify against a real build that the Vite plugin's `dist/app/wrangler.json` contains `triggers.crons` (record the result in the design).
  Satisfies: CRON-1.1, CRON-1.2
  Tests: table of valid/invalid expressions (names, steps, ranges, lists, day-of-month/day-of-week OR rule, aliases rejected); nextRun across month/year/leap-day boundaries; min-interval detection; duplicates; over-limit; `triggers` with extra keys → CON-R11.

- [ ] **2. Schema + `syncSchedules` + deploy integration + delete_app**
  Migration, `Artifact.config.crons`, `activate` step, delete_app cascade.
  Satisfies: CRON-1.3, CRON-1.4, CRON-2.7
  Tests: add/remove/keep semantics; rollback applies the older set; new deployment un-pauses; deleted app has none; dormant when not live.

- [ ] **3. Dispatcher strips `x-platform-cron`**
  Satisfies: CRON-2.3
  Tests: header removed on public requests (also mixed case); other headers untouched.

- [ ] **4. Runner + tick** (`runDueSchedules`, `DISPATCHER` binding and `* * * * *` cron on the api)
  Satisfies: CRON-2.1, CRON-2.2, CRON-2.4, CRON-2.5, CRON-2.6, CRON-2.8
  Tests (fake dispatcher): due schedules run oldest first up to the tick cap; claim is atomic (two ticks never double-run); request shape (URL, header, body); status mapping incl. timeout and skipped-overlap; no back-fill; failure streak pauses and manual success un-pauses; history capped; error body truncated; metrics written.

- [ ] **5. Tools** (`list_schedules`, `run_schedule`)
  Satisfies: CRON-3.1, CRON-3.2, CRON-3.3
  Tests: shape and ordering; manual run doesn't move next run; rate limit; unknown expression → `NOT_FOUND` with the declared list; requires ready app; catalog conformance.

- [ ] **6. Guide + fixture**
  `guide/schedules.md`, `POST /api/__cron` in the fixture (writes a row / increments a counter, and records whether the header was present), `crons` in the fixture's `wrangler.jsonc`.
  Satisfies: CRON-3.4
  Tests: guide contents; fixture passes the validator and builds.

- [ ] **7. E2E on dev** (spec 12)
  Flows: `F-CRON-1` (deploy the fixture with `*/5 * * * *`; `list_schedules` shows it with a next run; `run_schedule` succeeds and the fixture's row appears via `query_database`; a public request carrying `x-platform-cron` is treated as anonymous), `F-CRON-2` (slow: an automatic run appears within 7 minutes).
  Satisfies: E2E-3.3
