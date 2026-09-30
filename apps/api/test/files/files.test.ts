import { MAX_FILE_BYTES, MAX_FILES_PER_WRITE, MAX_WRITE_BYTES, READ_FILE_MAX_BYTES } from '@repo/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dailyUsage } from '../../src/apps/quota';
import { deployments } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { pathProblem, validateOperations } from '../../src/repos/files';
import { createApp } from '../../src/tools/apps/create-app';
import { listFiles } from '../../src/tools/files/list-files';
import { readFile } from '../../src/tools/files/read-file';
import { writeFiles } from '../../src/tools/files/write-files';
import { errorJson, signIn, type TestContext, testContext } from '../mcp/helpers';

const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => errorJson(r);
const data = <T = Record<string, unknown>>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
type WriteResult = {
  commit_sha: string;
  files_changed: number;
  skipped: string[];
  no_changes: boolean;
  deployment: { id: string; status: string } | null;
  next_step: string;
};

async function readyApp(): Promise<{ ctx: TestContext; slug: string; repo: string }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = data<{ slug: string }>(
    await runTool(createApp, { name: `Files ${Math.random().toString(36).slice(2, 8)}` }, ctx),
  );
  return { ctx, slug, repo: `dev-${slug}` };
}
const write = (ctx: TestContext, slug: string, input: Record<string, unknown>) =>
  runTool(writeFiles, { app: slug, message: 'change', ...input }, ctx);

describe('path and size validation (SRC-2.3 – 2.5)', () => {
  it.each([
    '/abs',
    './x',
    'a\\b',
    'a//b',
    'a/../b',
    'a/./b',
    '.git/config',
    'src/.git/x',
    'dir/',
    'bad\u0001name',
    'x'.repeat(257),
    '',
  ])('rejects %j', (path) => expect(pathProblem(path)).not.toBeNull());
  it.each(['src/api/index.ts', 'index.html', 'migrations/0001_init.sql', '.gitignore', 'a/b.c/d'])(
    'accepts %j',
    (path) => expect(pathProblem(path)).toBeNull(),
  );

  it('reports every bad path, managed paths, and size limits at the boundaries', () => {
    expect(() =>
      validateOperations([
        { path: '/x', op: 'delete' },
        { path: 'a/../b', op: 'delete' },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        details: { issues: expect.arrayContaining([expect.anything(), expect.anything()]) },
      }),
    );
    expect(() => validateOperations([{ path: '.github/workflows/deploy.yml', op: 'delete' }])).toThrowError(
      expect.objectContaining({ code: 'PROTECTED_PATH', details: { paths: ['.github/workflows/deploy.yml'] } }),
    );
    expect(() =>
      validateOperations([{ path: 'platform.json', op: 'upsert', content: '{}', encoding: 'utf8' }]),
    ).toThrowError(expect.objectContaining({ code: 'PROTECTED_PATH' }));
    const big = (bytes: number) => ({
      path: 'f',
      op: 'upsert' as const,
      content: 'x'.repeat(bytes),
      encoding: 'utf8' as const,
    });
    expect(() => validateOperations([big(MAX_FILE_BYTES)])).not.toThrow();
    expect(() => validateOperations([big(MAX_FILE_BYTES + 1)])).toThrowError(
      expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    );
    const many = Array.from({ length: MAX_FILES_PER_WRITE + 1 }, (_, i) => ({ path: `f${i}`, op: 'delete' as const }));
    expect(() => validateOperations(many)).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    const heavy = Array.from({ length: Math.ceil(MAX_WRITE_BYTES / MAX_FILE_BYTES) + 1 }, (_, i) => ({
      ...big(MAX_FILE_BYTES),
      path: `f${i}`,
    }));
    expect(() => validateOperations(heavy)).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });

  it('validates before any GitHub call', async () => {
    const { ctx, slug } = await readyApp();
    const before = ctx.fakes.github.repos.get(`dev-${slug}`)?.commits.size;
    expect(errorOf(await write(ctx, slug, { files: [{ path: '.github/x', content: 'y' }] })).code).toBe(
      'PROTECTED_PATH',
    );
    expect(ctx.fakes.github.repos.get(`dev-${slug}`)?.commits.size).toBe(before);
  });
});

describe('write_files (SRC-2)', () => {
  it('commits upserts and deletes as one commit with trailers and queues a deployment', async () => {
    const { ctx, slug, repo } = await readyApp();
    data(await write(ctx, slug, { files: [{ path: 'old.txt', content: 'bye' }], deploy: false }));
    const result = data<WriteResult>(
      await write(ctx, slug, {
        message: 'Add app',
        files: [
          { path: 'src/api/index.ts', content: 'export default {}' },
          { path: 'logo.png', content: btoa('\u0089PNG'), encoding: 'base64' },
          { path: 'old.txt', op: 'delete' },
          { path: 'never-existed.txt', op: 'delete' },
        ],
      }),
    );
    expect(result).toMatchObject({ files_changed: 3, skipped: ['never-existed.txt'], no_changes: false });
    expect(result.deployment?.status).toBe('queued');
    expect(result.next_step).toContain('get_deployment');

    const files = ctx.fakes.github.mainFiles(repo);
    expect(files['src/api/index.ts']).toBe('export default {}');
    expect(files['old.txt']).toBeUndefined();
    const commit = ctx.fakes.github.repos.get(repo)?.commits.get(result.commit_sha);
    expect(commit?.message).toMatch(/^Add app\n\nPlatform-User: usr_.+\nPlatform-App: app_.+$/);

    const dep = await ctx.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, result.deployment?.id as string))
      .get();
    expect(dep).toMatchObject({
      status: 'queued',
      trigger: 'push',
      commitSha: result.commit_sha,
      commitMessage: 'Add app',
    });
  });

  it('adds [skip ci] and creates no deployment when deploy=false; quota only counts deploys (SRC-2.8, SRC-2.9)', async () => {
    const { ctx, slug, repo } = await readyApp();
    const result = data<WriteResult>(
      await write(ctx, slug, { files: [{ path: 'a.txt', content: '1' }], deploy: false }),
    );
    expect(result.deployment).toBeNull();
    expect(ctx.fakes.github.repos.get(repo)?.commits.get(result.commit_sha)?.message).toContain('[skip ci]');
    expect((await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used).toBe(0);
    data(await write(ctx, slug, { files: [{ path: 'a.txt', content: '2' }] }));
    expect((await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used).toBe(1);
  });

  it('creates nothing and refunds the quota when nothing changes (SRC-2.11)', async () => {
    const { ctx, slug } = await readyApp();
    data(await write(ctx, slug, { files: [{ path: 'same.txt', content: 'x' }], deploy: false }));
    const result = data<WriteResult>(await write(ctx, slug, { files: [{ path: 'same.txt', content: 'x' }] }));
    expect(result).toMatchObject({ no_changes: true, deployment: null, files_changed: 0 });
    expect((await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used).toBe(0);
  });

  it('rejects a stale base_commit_sha with the current head (SRC-2.6)', async () => {
    const { ctx, slug, repo } = await readyApp();
    const first = data<WriteResult>(await write(ctx, slug, { files: [{ path: 'a', content: '1' }], deploy: false }));
    const head = await ctx.fakes.github.pushExternal(repo, 'b', 'someone else');
    const error = errorOf(
      await write(ctx, slug, { files: [{ path: 'a', content: '2' }], base_commit_sha: first.commit_sha }),
    );
    expect(error).toMatchObject({ code: 'COMMIT_CONFLICT', details: { head_commit_sha: head } });
  });

  it('rebuilds once when main moves mid-write, then gives up with COMMIT_CONFLICT (SRC-2.7)', async () => {
    const { ctx, slug, repo } = await readyApp();
    ctx.fakes.github.raceNextUpdate(1);
    const retried = data<WriteResult>(await write(ctx, slug, { files: [{ path: 'r', content: '1' }], deploy: false }));
    expect(ctx.fakes.github.mainFiles(repo).r).toBe('1');
    expect(retried.no_changes).toBe(false);
    ctx.fakes.github.raceNextUpdate(2);
    expect(errorOf(await write(ctx, slug, { files: [{ path: 'r', content: '2' }] })).code).toBe('COMMIT_CONFLICT');
    expect((await dailyUsage(ctx.db, ctx.orgId as string, 'deploys', ctx.clock.now())).used).toBe(0);
    const queued = await ctx.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.status, 'queued')))
      .all();
    expect(queued.some((d) => d.commitSha === retried.commit_sha)).toBe(false);
  });
});

describe('list_files / read_file (SRC-3, SRC-1.5)', () => {
  it('lists files with sizes and the managed flag, filtered by prefix', async () => {
    const { ctx, slug } = await readyApp();
    data(
      await write(ctx, slug, {
        files: [
          { path: 'src/a.ts', content: 'abc' },
          { path: 'README.md', content: 'hi' },
        ],
        deploy: false,
      }),
    );
    const all = data<{ commit_sha: string; files: { path: string; size: number; managed: boolean }[] }>(
      await runTool(listFiles, { app: slug }, ctx),
    );
    expect(all.files).toEqual(
      expect.arrayContaining([
        { path: 'src/a.ts', size: 3, managed: false },
        { path: 'platform.json', size: expect.any(Number), managed: true },
        { path: '.github/workflows/deploy.yml', size: expect.any(Number), managed: true },
      ]),
    );
    const src = data<{ files: { path: string }[] }>(await runTool(listFiles, { app: slug, prefix: 'src/' }, ctx));
    expect(src.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(JSON.stringify(all)).not.toMatch(/github\.com|repo_id|AI-app-hosting/);
  });

  it('reads text in line-bounded chunks and binary as base64', async () => {
    const { ctx, slug } = await readyApp();
    const line = `${'x'.repeat(99)}\n`;
    const long = line.repeat(Math.ceil((READ_FILE_MAX_BYTES * 1.5) / line.length));
    data(
      await write(ctx, slug, {
        files: [
          { path: 'long.txt', content: long },
          { path: 'bin', content: btoa('\u0000\u0001'), encoding: 'base64' },
        ],
        deploy: false,
      }),
    );

    const first = data<{ content: string; truncated: boolean; next_offset: number; encoding: string }>(
      await runTool(readFile, { app: slug, path: 'long.txt' }, ctx),
    );
    expect(first.truncated).toBe(true);
    expect(first.content.endsWith('\n')).toBe(true);
    expect(first.content.length).toBeLessThanOrEqual(READ_FILE_MAX_BYTES);
    const second = data<{ content: string; truncated: boolean }>(
      await runTool(readFile, { app: slug, path: 'long.txt', offset: first.next_offset }, ctx),
    );
    expect(first.content + second.content).toBe(long);
    expect(second.truncated).toBe(false);

    const binary = data<{ encoding: string; content: string }>(
      await runTool(readFile, { app: slug, path: 'bin' }, ctx),
    );
    expect(binary).toMatchObject({ encoding: 'base64', content: btoa('\u0000\u0001') });
  });

  it('reads older commits and reports missing paths or refs as NOT_FOUND (SRC-3.4, SRC-3.5)', async () => {
    const { ctx, slug } = await readyApp();
    const v1 = data<WriteResult>(await write(ctx, slug, { files: [{ path: 'v.txt', content: 'one' }], deploy: false }));
    data(await write(ctx, slug, { files: [{ path: 'v.txt', content: 'two' }], deploy: false }));
    const old = data<{ content: string }>(
      await runTool(readFile, { app: slug, path: 'v.txt', ref: v1.commit_sha }, ctx),
    );
    expect(old.content).toBe('one');
    expect(errorOf(await runTool(readFile, { app: slug, path: 'missing.txt' }, ctx)).code).toBe('NOT_FOUND');
    expect(errorOf(await runTool(listFiles, { app: slug, ref: 'f'.repeat(40) }, ctx)).code).toBe('NOT_FOUND');
    expect(errorOf(await runTool(listFiles, { app: slug, ref: 'main' }, ctx)).code).toBe('INVALID_INPUT');
  });
});
