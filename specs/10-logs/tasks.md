# 10 — Logs: Tasks

Depends on: 00, 04, 07 (`GitHubClient.getJobLog`), 08 (deployments, fail callback).

- [x] **1. `parseBuildErrors`**
  Satisfies: LOG-1.2
  Tests: fixtures of real outputs (tsc both formats, vite unresolved import, esbuild error, npm ERESOLVE, npm E404, unknown) → expected structured errors; path normalization; max 20; de-dup.

- [x] **2. Build log in `get_deployment` + GitHub fallback**
  Satisfies: LOG-1.1, LOG-1.3, LOG-1.4
  Tests: failed deployment returns step, excerpt, errors; contract failure returns violations only; missing excerpt triggers one `getJobLog` call, result persisted (second call makes no GitHub request); ANSI/timestamps stripped.

- [ ] **3. Tail Worker normalization**
  Satisfies: LOG-2.2, LOG-2.3, LOG-2.4, LOG-2.8
  Tests: synthetic `TraceItem`s (ok request with logs, exception, exceededCpu) → expected entries; no headers/query/IP in output; truncation; malformed trace doesn't throw.

- [ ] **4. `AppLogBuffer` DO**
  Satisfies: LOG-2.5, LOG-2.7
  Tests (pool-workers): append/query; retention by count and age (alarm, fake time); per-minute ingest cap keeps request/exception, drops console, writes one `dropped` entry.

- [ ] **5. Pipeline archival (`app-logs-<env>`)**
  Satisfies: LOG-2.6
  Tests: fake pipeline receives each entry with `app_id`; send failure doesn't affect DO write.

- [ ] **6. Attach tail consumer in deploy** (coordinate with spec 08 task 7)
  Satisfies: LOG-2.1
  Tests: upload metadata includes `tail_consumers: [{ service: "tail-<env>" }]` and tags.

- [ ] **7. `get_logs` tool**
  Satisfies: LOG-3.1, LOG-3.2, LOG-3.3, LOG-3.4, LOG-3.5
  Tests: relative/ISO time parsing; each filter; level ordering; cursor pagination; limit cap; empty result `next_step` for not-deployed vs no-match.

- [ ] **8. E2E on dev** (spec 12)
  Flows: `F-LOG-1`, `F-DEP-3` (parsed build errors).
  Satisfies: E2E-3.3
