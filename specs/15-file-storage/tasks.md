# 15 — File Storage: Tasks

Depends on: 03 (app provisioning steps, `apps` schema), 09 (bindings, `CloudflareClient`, contract validator), 11 (`aws4fetch` SigV4 precedent, task 3), 12 (e2e purge job, task 5), 13 (usage collector, pricing, task 6).

- [x] **1. `CloudflareClient.createR2` / `findR2` + schema + provisioning step**
  `apps.r2_bucket_name`, `appResourceNames.r2BucketName`, the `r2` `provisionSteps` entry.
  Satisfies: FILE-1.1, FILE-1.2, FILE-1.3, FILE-1.4
  Tests: creates a bucket named `app-<slug>-<env>`; idempotent re-run when the bucket already exists (both "we created it" and "found by `findR2`" paths); `retry_provisioning` re-runs it like any other step; `delete_app` does not touch `r2_bucket_name` or the bucket.

- [x] **2. `FILES` binding**
  `buildBindings` adds the `r2_bucket` binding; contract validator's `RESERVED_BINDINGS` gains `FILES`.
  Satisfies: FILE-2.1, FILE-2.2
  Tests: deployed script bindings include `{ type: "r2_bucket", name: "FILES", bucket_name }`; `vars.FILES` in `wrangler.jsonc` → `CON-R10`; an `r2_buckets` key in `wrangler.jsonc` → `CON-R11` (already covered by the existing unsupported-key rule — add a fixture case).

- [x] **3. R2 API token + `R2ObjectClient` (aws4fetch, SigV4)**
  Provision an R2 API token (Object Read & Write, Admin, all buckets) in dev and prod; `R2_ACCESS_KEY`/`R2_SECRET_ACCESS_KEY` in `.env.example` and uploaded via `pnpm secrets:dev`/`:prod`; `apps/api/src/integrations/r2-objects.ts` with `list(bucket, { prefix?, cursor? })` and `deleteAll(bucket, keys)` against R2's S3-compatible API.
  Satisfies: (infrastructure for FILE-3 and the e2e purge step below)
  Tests: SigV4 request shape against a recorded fixture (same pattern as `SesClient`, spec 11 task 2); pagination (`IsTruncated`/`NextContinuationToken`) → `cursor`/`truncated`; 4xx/5xx → `UPSTREAM_ERROR`. A fake backs every other task's tests.
  Verified live: `R2ObjectClient.list`'s exact request signed and sent against the real `artifacts-dev` bucket with the dev token, confirming the S3 XML response shape before deploying; deployed, `/healthz` and `apps.e2e.ts` (create_app) both green. Open: create the prod R2 API token when prod is set up.

- [x] **4. `list_storage_objects` tool**
  Satisfies: FILE-3.1, FILE-3.2, FILE-3.3
  Tests: lists objects under a prefix with pagination (`cursor`, `truncated`); empty bucket → empty list; unknown app → `NOT_FOUND`; bucket not yet provisioned → `NOT_FOUND` with a retry-provisioning hint; result shape has no content field.

- [x] **5. E2E purge empties and deletes the bucket** (`apps/api/src/jobs/purge-e2e.ts`)
  `deleteR2` on `CloudflareClient`; the bucket-emptying step using `R2ObjectClient` before it.
  Satisfies: E2E-4.2 (extended)
  Deployed and healthy on dev. Live verification of an actual purge is via the next natural hourly cron tick (no manual trigger — `wrangler dev` / forcing scheduled handlers isn't used per CLAUDE.md); unit tests cover pagination and the mid-empty-failure retry path.
  Tests: a purged app's bucket is emptied (paginated) then deleted; a bucket that's already gone (`findR2` → null path covered elsewhere) doesn't fail the purge; failure mid-empty retries the whole user next run, like every other purge resource.

- [x] **6. Usage metering: `r2_storage_bytes`, `r2_class_a_operations`, `r2_class_b_operations`**
  `CloudflareAnalyticsClient.r2Storage`/`r2Operations` (confirm exact GraphQL field names against Cloudflare's schema first), `collectUsage` wiring, pricing entries.
  Satisfies: (spec 13 USG-1, extended)
  Tests: GraphQL query shape (fixture response → parsed rows, matching the `d1`/`d1Storage` test pattern); attribution by `r2_bucket_name`; snapshot vs flow write modes in `app_usage_daily`; `estimateCostUsd` includes the three metrics.
  Confirmed the real schema by introspection against the live dev token before writing any code: types are `AccountR2StorageAdaptiveGroups` (fields `dimensions.bucketName`, `max.payloadSize`) and `AccountR2OperationsAdaptiveGroups` (`dimensions.{bucketName,actionType}`, `sum.requests`) — query field names are the type name lower-cased, confirmed against `d1`'s already-working query. `actionType` has no class field or enum (plain string); Class A/B lists came from Cloudflare's pricing docs and were checked against real recorded actionType values pulled live (PutBucket, HeadBucket, ListObjects, PutObject, CreateMultipartUpload, GetObject, UploadPart, CompleteMultipartUpload, deletes). Two aliased groups (`classA`/`classB`) filtered server-side via `actionType_in`, in one GraphQL call. Deployed; `/healthz` green. Live confirmation of an actual collection run is deferred to the next hourly cron tick, same as task 5 — no way to force-trigger it outside `wrangler dev` (not used here).

- [ ] **7. Guide: `env.FILES`**
  `contract.md`'s injected-bindings list gains `FILES: R2Bucket`; a storage section (new topic or folded into `database.md`) covering `put`/`get`/`delete`/`list`, serving files by proxying through the app's own routes, and storing the key scheme in D1 if the app needs to query uploads.
  Satisfies: MCP-2.2 (storage guidance)
  Tests: guide contains the binding name and basic R2Bucket usage; contract fixture app exercises `env.FILES` in at least one route.

- [ ] **8. E2E on dev** (spec 12)
  Flow: `F-FILE-1`.
  Satisfies: E2E-3.3
