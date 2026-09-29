# 15 — File Storage: Tasks

Depends on: 03 (app provisioning steps, `apps` schema), 09 (bindings, `CloudflareClient`, contract validator), 13 (usage collector, pricing) for tasks 4–5.

- [ ] **1. `CloudflareClient.createR2` / `findR2` + schema + provisioning step**
  `apps.r2_bucket_name`, `appResourceNames.r2BucketName`, the `r2` `provisionSteps` entry.
  Satisfies: FILE-1.1, FILE-1.2, FILE-1.3, FILE-1.4
  Tests: creates a bucket named `app-<slug>-<env>`; idempotent re-run when the bucket already exists (both "we created it" and "found by `findR2`" paths); `retry_provisioning` re-runs it like any other step; `delete_app` does not touch `r2_bucket_name` or the bucket.

- [ ] **2. `FILES` binding**
  `buildBindings` adds the `r2_bucket` binding; contract validator's `RESERVED_BINDINGS` gains `FILES`.
  Satisfies: FILE-2.1, FILE-2.2
  Tests: deployed script bindings include `{ type: "r2_bucket", name: "FILES", bucket_name }`; `vars.FILES` in `wrangler.jsonc` → `CON-R10`; an `r2_buckets` key in `wrangler.jsonc` → `CON-R11` (already covered by the existing unsupported-key rule — add a fixture case).

- [ ] **3. `list_storage_objects` tool**
  Satisfies: FILE-3.1, FILE-3.2, FILE-3.3
  Tests: lists objects under a prefix with pagination (`cursor`, `truncated`); empty bucket → empty list; unknown app → `NOT_FOUND`; bucket not yet provisioned → `NOT_FOUND` with a retry-provisioning hint; result shape has no content field.

- [ ] **4. Usage metering: `r2_storage_bytes`, `r2_class_a_operations`, `r2_class_b_operations`**
  `CloudflareAnalyticsClient.r2Storage`/`r2Operations` (confirm exact GraphQL field names against Cloudflare's schema first), `collectUsage` wiring, pricing entries.
  Satisfies: (spec 13 USG-1, extended)
  Tests: GraphQL query shape (fixture response → parsed rows, matching the `d1`/`d1Storage` test pattern); attribution by `r2_bucket_name`; snapshot vs flow write modes in `app_usage_daily`; `estimateCostUsd` includes the three metrics.

- [ ] **5. Guide: `env.FILES`**
  `contract.md`'s injected-bindings list gains `FILES: R2Bucket`; a storage section (new topic or folded into `database.md`) covering `put`/`get`/`delete`/`list`, serving files by proxying through the app's own routes, and storing the key scheme in D1 if the app needs to query uploads.
  Satisfies: MCP-2.2 (storage guidance)
  Tests: guide contains the binding name and basic R2Bucket usage; contract fixture app exercises `env.FILES` in at least one route.

- [ ] **6. E2E on dev** (spec 12)
  Flow: `F-FILE-1`.
  Satisfies: E2E-3.3
