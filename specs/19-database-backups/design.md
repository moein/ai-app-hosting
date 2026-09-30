# 19 — Database Backups & Restore: Design

## Cloudflare API (verified against the live API on 2026-09-30)

| Purpose | Call |
|---|---|
| Bookmark now / at a time | `GET /accounts/{a}/d1/database/{id}/time_travel/bookmark[?timestamp=<ISO>]` → `{ result: { bookmark } }` |
| Restore in place | `POST /accounts/{a}/d1/database/{id}/time_travel/restore?bookmark=<b>` (or `?timestamp=`) → `{ result: { bookmark, previous_bookmark, message } }` |
| Export | `POST /accounts/{a}/d1/database/{id}/export` body `{ output_format: 'polling', current_bookmark? }` → polling responses `{ result: { status: 'active'|'complete'|'error', at_bookmark, messages, result?: { filename, signed_url } } }`; the URL is valid one hour; the export must be polled continuously or it cancels, and the database is unavailable while it runs |

A scratch-database spike confirmed: after `INSERT` + `DROP TABLE`, restoring to an earlier bookmark brought the data back, and `previous_bookmark` is returned for undo. Restores cancel in-flight queries.

## `CloudflareClient` additions (`apps/api/src/integrations/cloudflare.ts`)

```ts
d1Bookmark(dbId: string, at?: Date): Promise<string>;
d1Restore(dbId: string, target: { bookmark: string } | { timestamp: Date }): Promise<{ bookmark: string; previousBookmark: string }>;
d1Export(dbId: string, options: { pollIntervalMs: number; timeoutMs: number }): Promise<{ signedUrl: string; atBookmark: string }>;
```

Same `UPSTREAM_ERROR` mapping; the fake gains an in-memory bookmark model (bookmarks are sortable strings; the fake keeps snapshots per bookmark using the local D1 for tests where feasible, or a simple log for shape tests).

## Data model

```sql
ALTER TABLE deployments ADD db_bookmark_before TEXT;     -- BKUP-1.2, null when no migration ran

CREATE TABLE database_restores (
  id            TEXT PRIMARY KEY,                        -- rst_<nanoid(11)>
  app_id        TEXT NOT NULL REFERENCES apps(id),
  user_id       TEXT,
  requested_at  INTEGER NOT NULL,
  target        TEXT NOT NULL,                           -- JSON { time | restore_point | before_deployment }
  restored_to   TEXT NOT NULL,                           -- bookmark restored to
  undo_bookmark TEXT,                                    -- previous_bookmark
  status        TEXT NOT NULL,                           -- 'running' | 'done' | 'failed'
  error         TEXT
);
CREATE INDEX database_restores_app ON database_restores (app_id, requested_at DESC);
```

`newId('rst')` joins the id prefixes. Serialization (BKUP-2.5, BKUP-3.4): a conditional insert of a `running` row per app (partial uniqueness by checking for `status='running'` newer than the timeout inside one batch), and a KV/D1 lock key `export:<appId>` with TTL `BACKUP_RESTORE_TIMEOUT_MS`.

## Tools

```
restore_database  in { app; confirm_slug; to: { time?: string; restore_point?: string; before_deployment?: string } }   // exactly one
                  out { restored_to: string /* ISO of the bookmark's time, best effort */; undo_restore_point: string; warning: string; next_step: string }
export_database   in { app }   out { key: string; bytes: number; restore_point: string; next_step: string }
query_database    out gains restore_point?: string (only with allow_writes)
get_deployment    out gains database_restore_point_available?: boolean
```

Annotations: `restore_database` `{ destructive, idempotent }` (repeating the same restore lands in the same state), `export_database` `{ }` (writes a file and briefly blocks the database). Titles: "Restore the app database", "Export the app database". The `time` parser accepts ISO 8601 or `<n>m|h|d` (same as `get_logs`, `parseTimeArg`). Redaction (spec 05): nothing sensitive in args.

## Flows

**`query_database` (allow_writes):** `d1Bookmark(db)` (best-effort, 3 s timeout) → run the statement → return `restore_point`. The extra call only happens for writes.

**Deploy migrate step (spec 08):** before applying pending migrations (not when `skipMigrations` or none pending): `bookmark = d1Bookmark(db)`; store on the deployment row in the same step; failure to fetch is logged and leaves it null (never blocks a deployment).

**`restore_database`:**
```
resolveApp(requireReady); confirm_slug matches
resolve target → bookmark: time → d1Bookmark(db, at); restore_point → as given (validated shape); before_deployment → deployment.db_bookmark_before (NOT_FOUND / INVALID_INPUT if null or expired)
age check (BACKUP_RETENTION_DAYS)
insert running restore row (CONFLICT if one is running)
{ bookmark, previousBookmark } = d1Restore(db, { bookmark })
update row done; return with undo_restore_point = previousBookmark
```

**`export_database`:** lock → `d1Export` (poll every 1 s, timeout 60 s) → stream the signed URL's body into R2 at `_platform/exports/<ts>.sql` through `R2ObjectClient.put` (new method, SigV4 `PUT` with `UNSIGNED-PAYLOAD`, streamed; bytes counted while streaming and aborted at `EXPORT_MAX_BYTES`) → prune to `EXPORTS_KEPT_PER_APP` (list + `deleteAll`) → return. The current bookmark from the export (`atBookmark`) is returned as `restore_point`.

`R2ObjectClient` (spec 15) gains `put(bucket, key, body, { contentType, maxBytes })`.

## Guide (`guide/database.md`)

New "Backups and restore" section: restore points come free with risky writes and migrations; `restore_database` recipes (`{ restore_point }`, `{ time: '30m' }`, `{ before_deployment }`), the undo point, the warning about lost writes and code not rolling back, exports and where they land, the `_platform/` prefix, an example download route (`FILES.get('_platform/exports/…')`).

## Limits (`packages/shared/src/limits.ts`)

| Constant | Value |
|---|---|
| `BACKUP_RETENTION_DAYS` | 30 |
| `BACKUP_RESTORE_TIMEOUT_MS` | 60_000 |
| `EXPORTS_KEPT_PER_APP` | 5 |
| `EXPORT_MAX_BYTES` | 50 MB |

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `EXPORT_TOO_LARGE` | false | The database is larger than `EXPORT_MAX_BYTES`. Use restore points (`restore_point` from query_database / get_deployment) instead of an export. |

Reused: `CONFLICT` (another restore/export is running), `INVALID_INPUT` (target too old, in the future, or none/several given), `NOT_FOUND` (unknown deployment), `UPSTREAM_ERROR`.

## Security notes

- Restore is destructive; `confirm_slug` guards accidental calls, the undo point limits the blast radius, and every restore is recorded (`database_restores`).
- Exports contain all the app's data; they land only in the app's own private bucket (never public, spec 15) and the tool never returns their contents through MCP.
- Time Travel bookmarks are opaque and per database; a bookmark from another app's database is rejected by Cloudflare (wrong database).

## Open questions

1. Scheduled automatic exports kept beyond 30 days.
2. Clone-to-new-database ("try this migration on a copy").
3. Whether to snapshot before `redeploy`/`rollback` too.
