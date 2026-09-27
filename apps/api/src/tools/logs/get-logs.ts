import { type LogFilter, PlatformError } from '@repo/shared';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { parseTimeArg } from '../../logs/time';
import { defineTool } from '../../mcp/tool';

const MAX_LIMIT = 200;

const EntrySchema = z.object({
  ts: z.string(),
  kind: z.enum(['request', 'console', 'exception', 'dropped']),
  level: z.enum(['debug', 'log', 'info', 'warn', 'error']),
  message: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  status: z.number().optional(),
  outcome: z.string().optional(),
  duration_ms: z.number().optional(),
  stack: z.string().optional(),
  invocation_id: z.string(),
});

export const getLogs = defineTool({
  name: 'get_logs',
  description:
    'Recent runtime logs of the live app, newest first: requests (method, path, status), console output and exceptions. Use it to debug what the user reports. Build errors are in get_deployment, not here.',
  public: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    since: z.string().optional().describe('ISO timestamp or duration like 15m, 2h, 1d. Default 1h.'),
    until: z.string().optional().describe('ISO timestamp or duration. Default now.'),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional().describe('Minimum level.'),
    kind: z.enum(['request', 'console', 'exception']).optional(),
    search: z.string().max(200).optional().describe('Case-insensitive text in the message or path.'),
    status_min: z.number().int().min(100).max(599).optional().describe('Only requests with at least this status.'),
    limit: z.number().int().min(1).optional().describe(`Max entries (default 50, at most ${MAX_LIMIT}).`),
    cursor: z.string().max(100).optional().describe('next_cursor from the previous call.'),
  }),
  output: z.object({
    entries: z.array(EntrySchema),
    next_cursor: z.string().nullable(),
    next_step: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app);
    const now = ctx.clock.now();
    const filter: LogFilter = {
      since: parseTimeArg(input.since ?? '1h', now, 'since'),
      until: input.until === undefined ? now + 1 : parseTimeArg(input.until, now, 'until'),
      limit: Math.min(input.limit ?? 50, MAX_LIMIT),
      ...(input.level ? { level: input.level } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.status_min === undefined ? {} : { status_min: input.status_min }),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
    if (input.cursor !== undefined && !/^\d+\.\d+$/.test(input.cursor)) {
      throw new PlatformError('INVALID_INPUT', { message: 'cursor: pass next_cursor from a previous get_logs call.' });
    }

    const page = await ctx.appLogs(app.id).query(filter);
    const entries = page.entries.map((entry) => ({ ...entry, ts: new Date(entry.ts).toISOString() }));
    if (entries.length > 0) return { entries, next_cursor: page.next_cursor };

    const filtered = input.level || input.kind || input.search || input.status_min !== undefined || input.cursor;
    const next_step = !app.liveDeploymentId
      ? 'The app has no live deployment yet, so there are no runtime logs. Deploy it first (write_files), then check get_deployment.'
      : filtered
        ? 'No entries match these filters. Widen `since` or remove filters.'
        : 'No traffic in this window. Open the app URL (or ask the user to try it), then call get_logs again, or widen `since`.';
    return { entries, next_cursor: null, next_step };
  },
});
