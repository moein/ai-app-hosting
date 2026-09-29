import { MAX_STORAGE_LIST_KEYS } from '@repo/shared';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { defineTool } from '../../mcp/tool';

export const listStorageObjects = defineTool({
  name: 'list_storage_objects',
  title: 'List stored files',
  description:
    "Lists the files in the app's storage bucket (key, size, upload time) — not their contents. Use it to debug an upload feature.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    prefix: z.string().optional().describe('Only keys under this prefix.'),
    cursor: z.string().optional().describe("From a previous call's `cursor`, to get the next page."),
  }),
  output: z.object({
    objects: z.array(z.object({ key: z.string(), size: z.number(), uploaded_at: z.string(), etag: z.string() })),
    cursor: z.string().nullable(),
    truncated: z.boolean(),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const page = await ctx.r2Objects.list(app.r2BucketName as string, {
      ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      limit: MAX_STORAGE_LIST_KEYS,
    });
    return {
      objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded_at: o.uploadedAt, etag: o.etag })),
      cursor: page.cursor,
      truncated: page.truncated,
    };
  },
});
