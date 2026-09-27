import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { insertApp } from '../../src/apps/insert';
import { apps } from '../../src/db/schema';
import { reconcileRoutes } from '../../src/jobs/reconcile-routes';
import { getRoute, putRoute } from '../../src/runtime/routes';
import { signIn, testContext } from '../mcp/helpers';

describe('route reconciliation (RUN-1.9)', () => {
  it('adds missing routes, removes stale ones and fixes mismatched state', async () => {
    const ctx = testContext();
    await signIn(ctx);
    const ready = await insertApp(ctx, { name: 'Ready app' });
    await ctx.db.update(apps).set({ provisioning: 'ready' }).where(eq(apps.id, ready.id));
    const live = await insertApp(ctx, { name: 'Live app' });
    await ctx.db.update(apps).set({ provisioning: 'ready', liveDeploymentId: 'dep_x' }).where(eq(apps.id, live.id));
    const deleted = await insertApp(ctx, { name: 'Deleted app' });
    await ctx.db.update(apps).set({ status: 'deleted', provisioning: 'ready' }).where(eq(apps.id, deleted.id));

    await putRoute(env.APP_ROUTES, live.slug, { appId: live.id, scriptName: live.slug, state: 'not_deployed' });
    await putRoute(env.APP_ROUTES, deleted.slug, { appId: deleted.id, scriptName: deleted.slug, state: 'live' });
    await putRoute(env.APP_ROUTES, 'ghost', { appId: 'app_ghost', scriptName: 'ghost', state: 'live' });

    expect(await reconcileRoutes(ctx.db, env.APP_ROUTES)).toEqual({ added: 1, removed: 2, fixed: 1 });
    expect(await getRoute(env.APP_ROUTES, ready.slug)).toMatchObject({ state: 'not_deployed' });
    expect(await getRoute(env.APP_ROUTES, live.slug)).toMatchObject({ state: 'live' });
    expect(await getRoute(env.APP_ROUTES, deleted.slug)).toBeNull();
    expect(await getRoute(env.APP_ROUTES, 'ghost')).toBeNull();
    expect(await reconcileRoutes(ctx.db, env.APP_ROUTES)).toEqual({ added: 0, removed: 0, fixed: 0 });
  });
});
