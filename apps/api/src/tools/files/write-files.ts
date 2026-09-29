import { newId, PlatformError } from '@repo/shared';
import { z } from 'zod';
import { consumeDaily, refundDaily } from '../../apps/quota';
import { resolveApp } from '../../apps/resolve';
import { deployments } from '../../db/schema';
import type { TreeEntry } from '../../integrations/github';
import { defineTool } from '../../mcp/tool';
import { type FileOperation, validateOperations } from '../../repos/files';

const FileSchema = z.union([
  z.object({
    path: z.string(),
    op: z.literal('upsert').default('upsert'),
    content: z.string(),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
  }),
  z.object({ path: z.string(), op: z.literal('delete') }),
]);

export const writeFiles = defineTool({
  name: 'write_files',
  title: 'Write app files',
  description:
    "Creates, updates or deletes files in the app's code as ONE commit. With deploy=true (default) the commit is built and deployed; use deploy=false for intermediate batches of a large change. You write all of the code — follow get_platform_guide. platform.json and .github/ are managed by the platform and cannot be written.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    files: z
      .array(FileSchema)
      .min(1)
      .describe('Files to write ({ path, content, encoding? }) or delete ({ path, op: "delete" }).'),
    message: z.string().trim().min(1).max(200).describe('Commit message describing the change.'),
    base_commit_sha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional()
      .describe('The commit your changes are based on; fails with COMMIT_CONFLICT if the code moved since.'),
    deploy: z.boolean().default(true).describe('Build and deploy this commit (default true).'),
  }),
  output: z.object({
    commit_sha: z.string(),
    files_changed: z.number(),
    skipped: z.array(z.string()),
    no_changes: z.boolean(),
    deployment: z.object({ id: z.string(), status: z.literal('queued') }).nullable(),
    next_step: z.string(),
  }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const files = input.files as FileOperation[];
    validateOperations(files); // before any I/O (SRC-2.3 – 2.5)

    const now = ctx.clock.now();
    if (input.deploy) await consumeDaily(ctx.db, app.orgId, 'deploys', now); // SRC-2.8
    let consumed = input.deploy;
    try {
      for (let attempt = 1; ; attempt++) {
        const head = await ctx.github.getHead(app.repoName);
        if (!head) throw new PlatformError('APP_NOT_READY', { message: 'The repository has no main branch yet.' });
        if (input.base_commit_sha && !head.commitSha.startsWith(input.base_commit_sha)) {
          throw new PlatformError('COMMIT_CONFLICT', { details: { head_commit_sha: head.commitSha } });
        }

        const existing = new Set((await ctx.github.listTree(app.repoName, head.commitSha))?.files.map((f) => f.path));
        const skipped = files.filter((f) => f.op === 'delete' && !existing.has(f.path)).map((f) => f.path);
        const entries: TreeEntry[] = files
          .filter((f) => !skipped.includes(f.path))
          .map((f) =>
            f.op === 'delete'
              ? { path: f.path, delete: true as const }
              : f.encoding === 'base64'
                ? { path: f.path, base64: f.content }
                : { path: f.path, content: f.content },
          );
        const message = `${input.message}${input.deploy ? '' : ' [skip ci]'}\n\nPlatform-User: ${ctx.userId}\nPlatform-App: ${app.id}`;

        const commit =
          entries.length === 0
            ? { commitSha: head.commitSha, changed: false }
            : await ctx.github.commit(app.repoName, {
                parentSha: head.commitSha,
                baseTreeSha: head.treeSha,
                entries,
                message,
              });
        if (!commit.changed) {
          if (consumed) await refundDaily(ctx.db, app.orgId, 'deploys', now);
          consumed = false;
          return {
            commit_sha: head.commitSha,
            files_changed: 0,
            skipped,
            no_changes: true,
            deployment: null,
            next_step: 'Nothing changed, so nothing was committed or deployed.',
          };
        }

        if ((await ctx.github.updateMain(app.repoName, commit.commitSha)) === 'not_fast_forward') {
          // Someone else moved main: with an explicit base that's a conflict; otherwise rebuild once (SRC-2.7).
          if (input.base_commit_sha || attempt >= 2) {
            const latest = await ctx.github.getHead(app.repoName);
            throw new PlatformError('COMMIT_CONFLICT', { details: { head_commit_sha: latest?.commitSha ?? null } });
          }
          continue;
        }

        let deployment: { id: string; status: 'queued' } | null = null;
        if (input.deploy) {
          const id = newId('dep');
          await ctx.db.insert(deployments).values({
            id,
            appId: app.id,
            orgId: app.orgId,
            trigger: 'push',
            commitSha: commit.commitSha,
            commitMessage: input.message.split('\n')[0] ?? null,
            status: 'queued',
            createdBy: ctx.userId ?? null,
            createdAt: now,
          });
          deployment = { id, status: 'queued' };
        }
        consumed = false;
        return {
          commit_sha: commit.commitSha,
          files_changed: entries.length,
          skipped,
          no_changes: false,
          deployment,
          next_step: deployment
            ? `Call get_deployment with app="${app.slug}", deployment="${deployment.id}" and wait_seconds=25 until status is live or failed.`
            : 'Files saved without deploying. Call write_files with deploy=true (or redeploy) when ready.',
        };
      }
    } finally {
      if (consumed) await refundDaily(ctx.db, app.orgId, 'deploys', now);
    }
  },
});
