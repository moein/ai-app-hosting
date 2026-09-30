import { MAX_SECRET_BYTES, MAX_SECRETS_PER_APP } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { appSecrets, apps, deployments } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { createApp } from '../../src/tools/apps/create-app';
import { writeFiles } from '../../src/tools/files/write-files';
import { deleteSecret, listSecrets, setSecret } from '../../src/tools/runtime/secrets';
import { artifactFiles, gzip, makeTar } from '../builds/tar';
import { errorJson, signIn, type TestContext, testContext } from '../mcp/helpers';

const data = <T>(r: Awaited<ReturnType<typeof runTool>>) => {
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as T;
};
const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => errorJson(r);

async function readyApp(): Promise<{ ctx: TestContext; slug: string; script: string }> {
  const ctx = testContext();
  await signIn(ctx);
  const { slug } = data<{ slug: string }>(
    await runTool(createApp, { name: `Sec ${Math.random().toString(36).slice(2, 8)}` }, ctx),
  );
  const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
  return { ctx, slug, script: app?.scriptName as string };
}

/** Deploys the artifact (whose config has `vars: { GREETING }`) through the inline deployer. */
async function deploy(ctx: TestContext, slug: string) {
  const write = data<{ deployment: { id: string } }>(
    await runTool(writeFiles, { app: slug, message: 'v', files: [{ path: 'a', content: String(Math.random()) }] }, ctx),
  );
  const id = write.deployment.id;
  const key = `artifacts/test/${id}.tar.gz`;
  await ctx.artifacts.put(key, await gzip(makeTar(artifactFiles())));
  await ctx.db.update(deployments).set({ status: 'deploying', artifactKey: key }).where(eq(deployments.id, id));
  await ctx.deployer.start({ deploymentId: id, artifactKey: key, skipMigrations: false });
}

describe('set_secret / list_secrets / delete_secret (RUN-3)', () => {
  it('stores the value on the script, lists names only and deletes idempotently', async () => {
    const { ctx, slug, script } = await readyApp();
    const set = data<{ name: string; next_step: string }>(
      await runTool(setSecret, { app: slug, name: 'STRIPE_API_KEY', value: 'sk_test_1' }, ctx),
    );
    expect(set).toMatchObject({ name: 'STRIPE_API_KEY', next_step: 'Read it in code as env.STRIPE_API_KEY.' });
    expect(ctx.fakes.cloudflare.scripts.get(script)?.secrets.get('STRIPE_API_KEY')).toBe('sk_test_1');

    ctx.clock.advance(1000);
    await runTool(setSecret, { app: slug, name: 'STRIPE_API_KEY', value: 'sk_test_2' }, ctx);
    expect(ctx.fakes.cloudflare.scripts.get(script)?.secrets.get('STRIPE_API_KEY')).toBe('sk_test_2');

    const listed = await runTool(listSecrets, { app: slug }, ctx);
    const { secrets } = data<{ secrets: Record<string, unknown>[] }>(listed);
    expect(secrets).toEqual([{ name: 'STRIPE_API_KEY', updated_at: new Date(ctx.clock.now()).toISOString() }]);
    expect(JSON.stringify(listed)).not.toContain('sk_test');

    expect(data(await runTool(deleteSecret, { app: slug, name: 'STRIPE_API_KEY' }, ctx))).toEqual({
      name: 'STRIPE_API_KEY',
      deleted: true,
    });
    expect(ctx.fakes.cloudflare.scripts.get(script)?.secrets.has('STRIPE_API_KEY')).toBe(false);
    expect(data(await runTool(deleteSecret, { app: slug, name: 'STRIPE_API_KEY' }, ctx))).toEqual({
      name: 'STRIPE_API_KEY',
      deleted: false,
    });
    expect(data<{ secrets: unknown[] }>(await runTool(listSecrets, { app: slug }, ctx)).secrets).toEqual([]);
  });

  it.each(['lower', 'A-B', '1ABC', `A${'B'.repeat(64)}`, 'DB', 'FILES', 'ASSETS', 'EMAIL'])(
    'rejects the name %s with SECRET_NAME_INVALID',
    async (name) => {
      const { ctx, slug } = await readyApp();
      expect(errorOf(await runTool(setSecret, { app: slug, name, value: 'x' }, ctx)).code).toBe('SECRET_NAME_INVALID');
      expect(ctx.fakes.cloudflare.calls.some((c) => c.method === 'putSecret')).toBe(false);
    },
  );

  it('rejects empty and oversized values (RUN-3.3)', async () => {
    const { ctx, slug } = await readyApp();
    expect(errorOf(await runTool(setSecret, { app: slug, name: 'K', value: '' }, ctx)).code).toBe('INVALID_INPUT');
    const big = 'é'.repeat(MAX_SECRET_BYTES / 2 + 1); // multi-byte: counts bytes, not characters
    expect(errorOf(await runTool(setSecret, { app: slug, name: 'K', value: big }, ctx)).code).toBe('INVALID_INPUT');
    expect(
      data(await runTool(setSecret, { app: slug, name: 'K', value: 'x'.repeat(MAX_SECRET_BYTES) }, ctx)),
    ).toBeTruthy();
  });

  it('enforces MAX_SECRETS_PER_APP but still allows updating an existing secret (RUN-3.6)', async () => {
    const { ctx, slug } = await readyApp();
    const app = await ctx.db.select().from(apps).where(eq(apps.slug, slug)).get();
    const rows = Array.from({ length: MAX_SECRETS_PER_APP }, (_, i) => ({
      appId: app?.id as string,
      name: `S${i}`,
      createdAt: 0,
      updatedAt: 0,
    }));
    for (let i = 0; i < rows.length; i += 20) await ctx.db.insert(appSecrets).values(rows.slice(i, i + 20));
    expect(errorOf(await runTool(setSecret, { app: slug, name: 'ONE_MORE', value: 'x' }, ctx)).code).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(data(await runTool(setSecret, { app: slug, name: 'S0', value: 'x' }, ctx))).toBeTruthy();
  });

  it("rejects names used by the live deployment's vars and keeps secrets across redeploys (RUN-3.2, RUN-3.7)", async () => {
    const { ctx, slug, script } = await readyApp();
    await deploy(ctx, slug);
    expect(errorOf(await runTool(setSecret, { app: slug, name: 'GREETING', value: 'x' }, ctx)).code).toBe(
      'SECRET_NAME_INVALID',
    );
    await runTool(setSecret, { app: slug, name: 'API_KEY', value: 'v1' }, ctx);
    await deploy(ctx, slug);
    const uploads = ctx.fakes.cloudflare.calls.filter((c) => c.method === 'uploadScript');
    expect(((uploads[uploads.length - 1]?.args[1] ?? {}) as { keep_bindings?: string[] }).keep_bindings).toContain(
      'secret_text',
    );
    expect(ctx.fakes.cloudflare.scripts.get(script)?.secrets.get('API_KEY')).toBe('v1');
  });

  it('requires a ready app of the caller', async () => {
    const { slug } = await readyApp();
    const other = testContext();
    await signIn(other, { email: 'someone-else@example.com' });
    expect(errorOf(await runTool(listSecrets, { app: slug }, other)).code).toBe('NOT_FOUND');
  });
});
