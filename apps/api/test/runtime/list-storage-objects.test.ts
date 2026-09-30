import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { apps } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { listStorageObjects } from '../../src/tools/runtime/list-storage-objects';
import { errorJson, signIn, type TestContext, testContext } from '../mcp/helpers';

type Result = {
  objects: { key: string; size: number; uploaded_at: string; etag: string }[];
  cursor: string | null;
  truncated: boolean;
};
const data = (r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as Result;
};
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => errorJson(r);

async function readyApp(): Promise<{ ctx: TestContext; slug: string }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = (await runTool(createApp, { name: `S ${Math.random().toString(36).slice(2, 8)}` }, ctx))
    .structuredContent as { slug: string };
  return { ctx, slug };
}

describe('list_storage_objects (FILE-3)', () => {
  it('lists objects in the app bucket under a prefix, newest fields intact, no content', async () => {
    const { ctx, slug } = await readyApp();
    const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
    const bucket = app?.r2BucketName as string;
    ctx.fakes.r2Objects.put(bucket, {
      key: 'uploads/a.png',
      size: 10,
      uploadedAt: '2026-09-29T00:00:00.000Z',
      etag: 'e1',
    });
    ctx.fakes.r2Objects.put(bucket, { key: 'tmp/b.png', size: 20, uploadedAt: '2026-09-29T00:00:01.000Z', etag: 'e2' });

    const all = data(await runTool(listStorageObjects, { app: slug }, ctx));
    expect(all.objects.map((o) => o.key).sort()).toEqual(['tmp/b.png', 'uploads/a.png']);
    expect(all.objects[0]).not.toHaveProperty('content');

    const filtered = data(await runTool(listStorageObjects, { app: slug, prefix: 'uploads/' }, ctx));
    expect(filtered).toEqual({
      objects: [{ key: 'uploads/a.png', size: 10, uploaded_at: '2026-09-29T00:00:00.000Z', etag: 'e1' }],
      cursor: null,
      truncated: false,
    });
  });

  it('forwards the input cursor to the client and returns its cursor/truncated as-is', async () => {
    const { ctx, slug } = await readyApp();
    const calls: unknown[] = [];
    ctx.r2Objects = {
      list: async (bucket, options) => {
        calls.push({ bucket, options });
        return { objects: [], cursor: 'next-page', truncated: true };
      },
      deleteAll: async () => {},
    };
    const result = data(await runTool(listStorageObjects, { app: slug, cursor: 'prev-page' }, ctx));
    expect(result).toEqual({ objects: [], cursor: 'next-page', truncated: true });
    expect(calls).toEqual([
      { bucket: `app-${slug}-dev`, options: { prefix: undefined, cursor: 'prev-page', limit: 200 } },
    ]);
  });

  it('an empty bucket returns an empty list', async () => {
    const { ctx, slug } = await readyApp();
    expect(data(await runTool(listStorageObjects, { app: slug }, ctx))).toEqual({
      objects: [],
      cursor: null,
      truncated: false,
    });
  });

  it('unknown app → NOT_FOUND', async () => {
    const ctx = testContext();
    await signIn(ctx);
    expect(errorOf(await runTool(listStorageObjects, { app: 'does-not-exist' }, ctx)).code).toBe('NOT_FOUND');
  });

  it('an app still provisioning → APP_NOT_READY', async () => {
    const ctx = testContext({ provisioner: { start: async () => {} } });
    // create_app polls clock.now() for up to CREATE_APP_WAIT_MS while waiting on the provisioner; with a
    // no-op provisioner that never finishes, sleep must fast-forward the clock or the wait loops forever
    // (app-tools.test.ts's APP-2.4 test does the same).
    ctx.sleep = async (ms) => void ctx.clock.advance(ms);
    await signIn(ctx);
    const { slug } = (await runTool(createApp, { name: 'Pending' }, ctx)).structuredContent as { slug: string };
    expect(errorOf(await runTool(listStorageObjects, { app: slug }, ctx)).code).toBe('APP_NOT_READY');
  });
});
