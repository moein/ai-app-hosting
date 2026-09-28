# 03 — Organizations & Apps: Tasks

Depends on: 00, 01, 02 (tasks 1, 5), 04 (tool framework). Steps calling GitHub/Cloudflare use the `integrations/` interfaces with fakes; real implementations land in specs 07 and 09.

- [x] **1. Schema: `organizations`, `memberships`, `apps`, `usage_counters`** (+ migration, Drizzle types)
  Satisfies: APP-1.1, APP-1.2, SLUG-3.1, SLUG-3.2
  Tests: migration applies; unique slugs; FK constraints enforced.

- [x] **2. Acting-org resolution + org hiding**
  Tool context carries `orgId` from session; output schemas contain no org fields.
  Satisfies: APP-1.3, APP-1.4
  Tests: tool ctx has personal org; schema test asserts no `org*` keys in any tool input/output schema.

- [x] **3. Quota service**
  `checkAppQuota`, `consumeDaily(metric)`, `getUsage`.
  Satisfies: APP-5.1, APP-5.2, APP-5.3, APP-2.8
  Tests: atomic increment stops exactly at max under concurrency (Promise.all of max+5); UTC day rollover with fake clock; `resets_at` correct.

- [x] **4. App lookup helper**
  `resolveApp(ctx, slug, { allowDeleted, requireReady })`.
  Satisfies: APP-3.3, APP-3.4, APP-3.5
  Tests: other org's slug → `NOT_FOUND`; deleted → `APP_DELETED`; pending/failed → `APP_NOT_READY`.

- [x] **5. `ProvisionApp` workflow (with fake integrations)**
  Satisfies: APP-2.3, APP-2.5, APP-2.6, APP-2.7
  Tests: happy path sets `ready` and all ids; each step idempotent when resource already exists; failure after retries sets `failed` + code; repo fake receives only managed files.

- [x] **6. `create_app`, `retry_provisioning` tools**
  Satisfies: APP-2.1, APP-2.2, APP-2.4, SLUG-4.1, SLUG-4.2
  Tests: name validation; generated vs requested slug; returns `ready` when workflow finishes fast; returns `pending` + `next_step` after wait timeout (fake clock); retry only allowed from `failed`.

- [x] **7. `list_apps`, `get_app`, `get_usage` tools**
  Satisfies: APP-3.1, APP-3.2, APP-5.4
  Tests: ordering, deleted excluded from list, deleted visible in `get_app` with status, deployment summaries null before first deploy.

- [x] **8. `delete_app` tool**
  Satisfies: APP-4.1, APP-4.2, APP-4.3, APP-4.4, APP-4.5, APP-4.6, APP-4.7
  Tests: only the Cloudflare "delete script" call is made (fakes record no repo/D1/R2 deletions); wrong `confirm_slug` deletes nothing; script-404 still succeeds; in-progress deployments cancelled; KV route removed; secrets rows removed; slug still taken afterwards.

- [x] **9. E2E on dev** (spec 12)
  Flows: `F-APP-1`, `F-APP-2`, `F-APP-3`, `F-APP-4`.
  Satisfies: E2E-3.3
