# 19 — Database Backups & Restore: Tasks

Depends on: 09 (`query_database`, `CloudflareClient`), 08 (migrate step, rollback), 15 (`R2ObjectClient`, app bucket).

- [ ] **1. `CloudflareClient` Time Travel + export, fake**
  `d1Bookmark`, `d1Restore`, `d1Export`.
  Satisfies: (infrastructure)
  Tests: request shapes and response mapping against recorded fixtures of the real responses; polling until complete; timeout; 4xx/5xx → `UPSTREAM_ERROR`.

- [ ] **2. Restore points: `query_database` and deployments**
  Migration (`db_bookmark_before`), `restore_point` in `query_database` writes, migrate-step capture, `get_deployment` flag.
  Satisfies: BKUP-1.1, BKUP-1.2, BKUP-1.3
  Tests: write returns the bookmark captured before executing; read-only statements don't fetch one; bookmark failure never blocks; migrations capture once before the first; no migrations → null; expired point reported unavailable.

- [ ] **3. `restore_database` tool**
  Migration (`database_restores`), lock, target resolution, `rollback` warning text.
  Satisfies: BKUP-2.1–2.7
  Tests: each target kind; exactly-one validation; wrong `confirm_slug`; too old/future; app not ready; concurrent restore → `CONFLICT`; failure leaves the row `failed` and returns `UPSTREAM_ERROR`; result contains the undo point; restoring to the undo point works (fake); audit row written; catalog conformance.

- [ ] **4. `R2ObjectClient.put` + `export_database` tool**
  Satisfies: BKUP-3.1–3.4, BKUP-3.6
  Tests: streamed upload with size cap → `EXPORT_TOO_LARGE` and no object left; key format; pruning keeps the newest N; serialization; export failure mid-way cleans up.

- [ ] **5. Guide**
  `database.md` backups section.
  Satisfies: BKUP-3.5
  Tests: guide mentions restore points, `restore_database`, the undo point, `export_database`, and `_platform/`.

- [ ] **6. E2E on dev** (spec 12)
  Flows: `F-BKUP-1` (fixture app: `query_database` write returns `restore_point`; delete rows; `restore_database({ restore_point })` brings them back; restore to the returned undo point re-deletes them), `F-BKUP-2` (deploy a migration; `restore_database({ before_deployment })` removes its effect), `F-BKUP-3` (`export_database` → object under `_platform/exports/` appears in `list_storage_objects` and contains the app's table).
  Satisfies: E2E-3.3
