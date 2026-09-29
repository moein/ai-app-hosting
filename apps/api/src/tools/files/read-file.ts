import { PlatformError, READ_FILE_MAX_BYTES } from '@repo/shared';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { toBase64 } from '../../integrations/github';
import { defineTool } from '../../mcp/tool';
import { decodeText } from '../../repos/files';
import { Ref } from './list-files';

export const readFile = defineTool({
  name: 'read_file',
  title: 'Read an app file',
  description:
    "Reads one file of the app's code. Long files come in chunks: when truncated is true, call again with offset=next_offset.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    path: z.string().describe('File path, e.g. "src/api/index.ts".'),
    ref: Ref,
    offset: z.number().int().min(0).default(0).describe('Byte offset to start from (for long files).'),
  }),
  output: z.object({
    path: z.string(),
    commit_sha: z.string(),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
    size: z.number(),
    truncated: z.boolean(),
    next_offset: z.number().optional(),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const tree = await ctx.github.listTree(app.repoName, input.ref ?? 'main');
    const file = tree?.files.find((f) => f.path === input.path);
    if (!tree || !file) {
      throw new PlatformError('NOT_FOUND', {
        message: `No file "${input.path}".`,
        hint: 'Call list_files to see the paths.',
      });
    }
    const bytes = await ctx.github.readBlob(app.repoName, file.sha);
    const text = decodeText(bytes);
    const rest = bytes.subarray(input.offset);
    let chunk = rest.subarray(0, READ_FILE_MAX_BYTES);
    if (text !== null && chunk.byteLength < rest.byteLength) {
      // End text chunks on a line boundary (SRC-3.3).
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline > 0) chunk = chunk.subarray(0, lastNewline + 1);
    }
    const truncated = input.offset + chunk.byteLength < bytes.byteLength;
    return {
      path: file.path,
      commit_sha: tree.commitSha,
      encoding: text === null ? ('base64' as const) : ('utf8' as const),
      content: text === null ? toBase64(chunk) : new TextDecoder().decode(chunk),
      size: bytes.byteLength,
      truncated,
      ...(truncated ? { next_offset: input.offset + chunk.byteLength } : {}),
    };
  },
});
