# Database

Every app has its own **D1** (SQLite) database, available as `env.DB`.

## Schema changes: migrations
- Put SQL files in `migrations/`, named `NNNN_description.sql` (`0001_init.sql`, `0002_add_todos.sql`, …).
- Before each deploy, the platform applies every migration that hasn't been applied yet, in filename order.
- **Never edit or rename a migration after it has been deployed.** Add a new numbered file instead. Editing an applied migration fails the deployment with `MIGRATION_FAILED` and keeps the previous version live.
- A failing statement also fails the deployment with `MIGRATION_FAILED` (the error names the file). Fix it by writing a corrected **new** migration if the broken one was never applied, or a follow-up migration otherwise.
- Rollbacks do not revert migrations.

## Querying from code
Use `env.DB.prepare(sql).bind(...).all()` / `.first()` / `.run()`, or Drizzle:

```ts
import { drizzle } from 'drizzle-orm/d1';
const db = drizzle(c.env.DB);
```

## Inspecting and fixing data
`query_database({ app, sql, params? })` runs one statement against the app's database. It is read-only unless you pass `allow_writes: true` — ask the user before changing data. See the schema with `SELECT name, sql FROM sqlite_master`. Results are capped at {{QUERY_MAX_ROWS}} rows.
