import { isManagedPath } from '@repo/app-contract';
import { PlatformError } from '@repo/shared';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { defineTool } from '../../mcp/tool';

export const Ref = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, 'Must be a commit SHA (7–40 hex characters).')
  .optional()
  .describe('A commit SHA; default: the latest commit on main.');

export const listFiles = defineTool({
  name: 'list_files',
  description:
    "Lists the files in the app's code (paths and sizes), optionally under a folder prefix or at an older commit.",
  public: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    prefix: z.string().optional().describe('Only files under this path prefix, e.g. "src/".'),
    ref: Ref,
  }),
  output: z.object({
    commit_sha: z.string(),
    files: z.array(z.object({ path: z.string(), size: z.number(), managed: z.boolean() })),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const tree = await ctx.github.listTree(app.repoName, input.ref ?? 'main');
    if (!tree) throw new PlatformError('NOT_FOUND', { message: `No commit ${input.ref ?? 'main'} in this app.` });
    return {
      commit_sha: tree.commitSha,
      files: tree.files
        .filter((file) => !input.prefix || file.path.startsWith(input.prefix))
        .map((file) => ({ path: file.path, size: file.size, managed: isManagedPath(file.path) })),
    };
  },
});
