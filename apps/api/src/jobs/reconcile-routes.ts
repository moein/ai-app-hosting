import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apps } from '../db/schema';
import { type AppRoute, putRoute, type RouteStore } from '../runtime/routes';

/** Makes KV routes match D1 (RUN-1.9): add missing, drop deleted/unknown, fix state/script mismatches. */
export async function reconcileRoutes(
  db: Db,
  kv: RouteStore,
): Promise<{ added: number; removed: number; fixed: number }> {
  const active = await db.select().from(apps).where(eq(apps.status, 'active')).all();
  const expected = new Map<string, AppRoute>(
    active
      .filter((app) => app.provisioning === 'ready' || app.liveDeploymentId)
      .map((app) => [
        app.slug,
        { appId: app.id, scriptName: app.scriptName, state: app.liveDeploymentId ? 'live' : 'not_deployed' },
      ]),
  );

  const existing = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : {});
    for (const key of page.keys) existing.add(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const result = { added: 0, removed: 0, fixed: 0 };
  for (const slug of existing) {
    const want = expected.get(slug);
    if (!want) {
      await kv.delete(slug);
      result.removed++;
      continue;
    }
    const have = await kv.get<AppRoute>(slug, 'json');
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      await putRoute(kv, slug, want);
      result.fixed++;
    }
  }
  for (const [slug, route] of expected) {
    if (existing.has(slug)) continue;
    await putRoute(kv, slug, route);
    result.added++;
  }
  return result;
}
