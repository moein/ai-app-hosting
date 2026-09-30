# 19 — Database Backups & Restore: Requirements

Mistakes happen: a bad migration, a `DELETE` without a `WHERE`, an app bug that overwrites data. Every app's D1 database already keeps a continuous history (D1 Time Travel: any minute of the last 30 days). This spec makes it usable through MCP: safe points are captured automatically before risky operations, restoring is one confirmed tool call, every restore can itself be undone, and the AI can export a full SQL copy of the database into the app's own file storage.

## Stories & acceptance criteria

### BKUP-1 — Restore points
As an AI client, I want to know how to go back before I change data, so that I can undo my own mistakes.

- **BKUP-1.1** WHEN `query_database` runs a statement with `allow_writes: true` THE SYSTEM SHALL capture the database's current Time Travel bookmark *before* executing it and return it as `restore_point` in the result (omitted if the bookmark can't be fetched, which never blocks the query).
- **BKUP-1.2** WHEN a deployment applies one or more new migrations THE SYSTEM SHALL capture the bookmark before the first one and store it on the deployment (`deployments.db_bookmark_before`); `get_deployment` SHALL include `database_restore_point_available: true` for such deployments within the retention window.
- **BKUP-1.3** THE SYSTEM SHALL retain restore points for `BACKUP_RETENTION_DAYS` (Time Travel's paid-plan window); older ones are reported as expired.

### BKUP-2 — Restoring
As a user, I want to undo a bad change, so that I don't lose my data.

- **BKUP-2.1** WHEN `restore_database({ app, confirm_slug, to })` is called THE SYSTEM SHALL restore the app's D1 database in place to exactly one target given in `to`: `{ time }` (ISO 8601 or a duration ago such as `2h`), `{ restore_point }` (a bookmark from BKUP-1 or an earlier restore's undo point), or `{ before_deployment }` (a deployment id whose `db_bookmark_before` is set).
- **BKUP-2.2** THE tool SHALL require `confirm_slug` equal to the app's slug (like `delete_app`), refuse targets older than `BACKUP_RETENTION_DAYS` or in the future (`INVALID_INPUT`), and refuse apps that aren't ready.
- **BKUP-2.3** THE SYSTEM SHALL return `{ restored_to, undo_restore_point, warning, next_step }` where `undo_restore_point` is the bookmark of the state before this restore; restoring to it undoes the restore.
- **BKUP-2.4** THE tool description and result SHALL state plainly that everything written after the target is lost, that in-flight requests fail during the restore, and that the app's code is not rolled back (`rollback` is separate).
- **BKUP-2.5** THE SYSTEM SHALL serialize restores per app (a second restore while one runs → `CONFLICT`) and track every restore in `database_restores` (who, when, target, undo point) for support.
- **BKUP-2.6** WHEN a restore fails THE SYSTEM SHALL return `UPSTREAM_ERROR` (retryable) and leave the database as it was.
- **BKUP-2.7** `rollback` (spec 08) SHALL mention in its warning that data is not rolled back and that `restore_database({ before_deployment })` can restore the database to before that deployment's migrations.

### BKUP-3 — Exports
As a user, I want a copy of my data, so that I own it and can move it.

- **BKUP-3.1** WHEN `export_database({ app })` is called THE SYSTEM SHALL export the database as a SQL dump (schema and data) and store it in the app's own R2 bucket at `_platform/exports/<UTC timestamp>.sql`, returning `{ key, bytes, restore_point, next_step }`.
- **BKUP-3.2** THE SYSTEM SHALL keep the newest `EXPORTS_KEPT_PER_APP` exports and delete older ones after a new export succeeds.
- **BKUP-3.3** IF the dump exceeds `EXPORT_MAX_BYTES` THEN the export SHALL fail with `EXPORT_TOO_LARGE` (the partial file is not kept) and the hint SHALL point to restore points as the safety net.
- **BKUP-3.4** THE tool description SHALL warn that the database is unavailable while the export runs and that it should be used deliberately (before big changes, or when the user asks for their data), and exports SHALL be serialized per app.
- **BKUP-3.5** THE guide (`database` topic) SHALL document restore points, restore, exports, the reserved `_platform/` prefix in `env.FILES`, and how to offer a user a download by writing an app route that streams the object.
- **BKUP-3.6** Exports count in the app's storage usage like any object (spec 15/13).

## Non-functional requirements

- A restore completes within `BACKUP_RESTORE_TIMEOUT_MS`; a typical export of a small database finishes in seconds.
- No SQL contents or exported data are logged or tracked (only ids, sizes, timestamps).

## Out of scope

- Restoring into a *different* database (clone/fork), table-level restores, scheduled automatic exports (Time Travel already covers 30 days), off-platform backup destinations, restoring the R2 bucket's contents.
