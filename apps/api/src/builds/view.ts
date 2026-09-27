import { BUILD_LOG_EXCERPT_MAX_BYTES, BUILD_LOG_EXCERPT_MAX_LINES, type Logger } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DeploymentRow, PublicDeploymentStatus, publicStatus } from '../apps/deployments';
import { appUrl } from '../apps/names';
import type { AppRow } from '../apps/resolve';
import type { Db } from '../db/client';
import { deployments } from '../db/schema';
import type { GitHubClient } from '../integrations/github';
import { type BuildError, cleanLog, parseBuildErrors } from '../logs/build-errors';

const BuildErrorSchema = z.object({
  kind: z.enum(['typescript', 'bundler', 'npm', 'other']),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  code: z.string().optional(),
  message: z.string(),
});

export const DeploymentViewSchema = z.object({
  id: z.string(),
  status: PublicDeploymentStatus,
  trigger: z.enum(['push', 'redeploy', 'rollback']),
  commit_sha: z.string(),
  commit_message: z.string().nullable(),
  source_deployment: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  url: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      step: z.string().optional(),
      violations: z.array(z.unknown()).optional(),
      build_log_excerpt: z.string().optional(),
      errors: z.array(BuildErrorSchema).optional(),
    })
    .nullable(),
  next_step: z.string(),
});
export type DeploymentView = z.infer<typeof DeploymentViewSchema>;

const TERMINAL = new Set(['live', 'superseded', 'failed', 'cancelled']);
export const isTerminal = (status: string) => TERMINAL.has(status);

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Last ≤ 200 lines / 20 KB of the failed step in a GitHub job log (LOG-1.3). */
export function excerptFromJobLog(log: string): string {
  const lines = cleanLog(log).split('\n');
  const errorAt = lines.findLastIndex((line) => line.includes('##[error]'));
  const end = errorAt === -1 ? lines.length : errorAt + 1;
  const start = lines.slice(0, end).findLastIndex((line) => line.includes('##[group]Run '));
  const section = lines.slice(Math.max(start, end - BUILD_LOG_EXCERPT_MAX_LINES), end);
  return section.join('\n').slice(-BUILD_LOG_EXCERPT_MAX_BYTES);
}

/** Fills in a missing build log excerpt from the GitHub Actions job log and stores it (LOG-1.3). */
async function ensureExcerpt(
  deps: { db: Db; github: GitHubClient; logger: Logger },
  app: AppRow,
  row: DeploymentRow,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (row.errorCode !== 'BUILD_FAILED' || details.log_tail || !row.runId) return details;
  try {
    const jobs = await deps.github.getRunJobs(app.repoName, row.runId);
    const job = jobs.find((j) => j.conclusion === 'failure') ?? jobs[0];
    if (!job) return details;
    const updated = { ...details, log_tail: excerptFromJobLog(await deps.github.getJobLog(app.repoName, job.id)) };
    await deps.db
      .update(deployments)
      .set({ errorDetails: JSON.stringify(updated).slice(0, 20_000) })
      .where(eq(deployments.id, row.id));
    return updated;
  } catch (error) {
    deps.logger.warn('could not fetch build log from GitHub', { deploymentId: row.id, error });
    return details;
  }
}

const nextStepFor = (status: string, slug: string, url: string, code?: string) => {
  switch (status) {
    case 'queued':
    case 'building':
    case 'deploying':
      return `Call get_deployment again with app="${slug}" and wait_seconds=25.`;
    case 'live':
      return `Tell the user their app is live at ${url}.`;
    case 'failed':
      return code === 'CONTRACT_VIOLATION'
        ? 'Fix every item in error.violations, then write_files again.'
        : code === 'MIGRATION_FAILED'
          ? 'Add a new numbered migration that fixes the problem (never edit an applied one), then write_files again.'
          : code === 'DEPLOY_FAILED'
            ? 'Call redeploy.'
            : 'Fix the problems listed in error, then write_files again.';
    case 'cancelled':
      return 'A newer deployment replaced this one; check the latest with get_deployment.';
    default:
      return 'This version is no longer live; call rollback to restore it if needed.';
  }
};

/** The AI-facing view of a deployment (DEP-3.1), including build errors (LOG-1.1, LOG-1.4). */
export async function toDeploymentView(
  deps: { db: Db; github: GitHubClient; logger: Logger; appsDomain: string },
  app: AppRow,
  row: DeploymentRow,
): Promise<DeploymentView> {
  const status = publicStatus(row, app.liveDeploymentId);
  const url = appUrl(app.slug, deps.appsDomain);
  let error: DeploymentView['error'] = null;
  if (row.status === 'failed' && row.errorCode) {
    let details = row.errorDetails ? (JSON.parse(row.errorDetails) as Record<string, unknown>) : {};
    details = await ensureExcerpt(deps, app, row, details);
    const logTail = typeof details.log_tail === 'string' ? details.log_tail : undefined;
    const errors: BuildError[] | undefined = logTail ? parseBuildErrors(logTail) : undefined;
    error = {
      code: row.errorCode,
      message: typeof details.message === 'string' ? details.message : `Deployment failed (${row.errorCode}).`,
      ...(typeof details.step === 'string' ? { step: details.step } : {}),
      ...(Array.isArray(details.violations) ? { violations: details.violations } : {}),
      ...(logTail ? { build_log_excerpt: logTail, errors } : {}),
    };
  }
  return {
    id: row.id,
    status,
    trigger: row.trigger,
    commit_sha: row.commitSha,
    commit_message: row.commitMessage,
    source_deployment: row.sourceDeploymentId,
    created_at: new Date(row.createdAt).toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    url: status === 'live' ? url : null,
    error,
    next_step: nextStepFor(status, app.slug, url, row.errorCode ?? undefined),
  };
}
