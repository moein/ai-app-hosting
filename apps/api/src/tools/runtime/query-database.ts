import { PlatformError, QUERY_MAX_BYTES, QUERY_MAX_ROWS } from '@repo/shared';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { defineTool } from '../../mcp/tool';
import { isReadOnly, splitStatements, touchesProtectedTables } from '../../runtime/sql';

const invalid = (message: string) =>
  new PlatformError('INVALID_INPUT', { message, details: { issues: [{ path: ['sql'], message }] } });

export const queryDatabase = defineTool({
  name: 'query_database',
  title: 'Query the app database',
  description:
    "Runs ONE SQL statement against the app's database. Read-only by default (SELECT, EXPLAIN, PRAGMA table_info…). To change data set allow_writes=true — ask the user first. See the schema with SELECT name, sql FROM sqlite_master.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    sql: z.string().min(1).max(100_000).describe('A single SQL statement; use ? placeholders for params.'),
    params: z
      .array(z.union([z.string(), z.number(), z.null()]))
      .max(100)
      .default([]),
    allow_writes: z.boolean().default(false).describe('Allow statements that change data or schema.'),
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    row_count: z.number(),
    truncated: z.boolean(),
    meta: z.object({ rows_read: z.number(), rows_written: z.number(), duration_ms: z.number() }),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const statements = splitStatements(input.sql);
    if (statements.length !== 1) throw invalid('Send exactly one SQL statement.');
    const statement = statements[0] as string;
    const readOnly = isReadOnly(statement);
    if (!readOnly && !input.allow_writes) {
      throw invalid('This statement can change data. Confirm with the user, then call again with allow_writes=true.');
    }
    if (!readOnly && touchesProtectedTables(statement))
      throw invalid('_platform_migrations and _cf_* tables are managed by the platform.');

    let result: Awaited<ReturnType<typeof ctx.cloudflare.d1Query>>[number] | undefined;
    try {
      [result] = await ctx.cloudflare.d1Query(app.d1DatabaseId as string, statement, input.params);
    } catch (error) {
      // D1 answers bad SQL with HTTP 400; anything else (outage, auth) is the platform's problem.
      if (error instanceof PlatformError && error.details?.status !== 400) throw error;
      const message =
        error instanceof PlatformError
          ? ((error.details?.errors as string[] | undefined)?.join('; ') ?? error.message)
          : error instanceof Error
            ? error.message
            : String(error);
      throw new PlatformError('QUERY_FAILED', { details: { message } });
    }

    const allRows = result?.rows ?? [];
    let rows = allRows.slice(0, QUERY_MAX_ROWS);
    while (rows.length > 0 && new TextEncoder().encode(JSON.stringify(rows)).byteLength > QUERY_MAX_BYTES) {
      rows = rows.slice(0, Math.floor(rows.length * 0.8));
    }
    return {
      columns: result?.columns ?? [],
      rows,
      row_count: allRows.length,
      truncated: rows.length < allRows.length,
      meta: {
        rows_read: result?.meta.rows_read ?? 0,
        rows_written: result?.meta.rows_written ?? 0,
        duration_ms: result?.meta.duration ?? 0,
      },
    };
  },
});
