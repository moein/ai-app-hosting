import { env } from 'cloudflare:workers';

let seq = 0;
const id = (prefix: string) => `${prefix}_${String(++seq).padStart(4, '0')}${crypto.randomUUID().slice(0, 7)}`;

/** A user, org (tenant status as given) and app in the platform D1 (schema from the api's migrations). */
export async function seedApp(
  options: {
    tenant?: 'pending' | 'ready' | 'failed';
    appStatus?: 'active' | 'deleted';
    emailStatus?: 'pending' | 'ready' | 'failed';
  } = {},
) {
  const userId = id('usr');
  const orgId = id('org');
  const appId = id('app');
  const slug = `app-${appId
    .slice(4)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, 0)').bind(userId, `${userId}@example.com`),
    env.DB.prepare(
      'INSERT INTO organizations (id, slug, name, email_tenant_status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)',
    ).bind(orgId, orgId.toLowerCase().replace(/_/g, '-'), 'Personal', options.tenant ?? 'ready'),
    env.DB.prepare(
      `INSERT INTO apps (id, org_id, slug, name, status, email_status, script_name, repo_owner, repo_name,
                         d1_database_name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'o', ?, ?, ?, 0, 0)`,
    ).bind(
      appId,
      orgId,
      slug,
      'Todo List',
      options.appStatus ?? 'active',
      options.emailStatus ?? 'ready',
      `app-${slug}`,
      slug,
      `app-${slug}`,
      userId,
    ),
  ]);
  return { userId, orgId, appId, slug, props: { appId, orgId, slug } };
}

export async function appEmailStatus(appId: string) {
  const row = await env.DB.prepare('SELECT email_status AS s FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ s: string }>();
  return row?.s;
}

export async function suppress(email: string, orgId: string | null, reason: 'bounce' | 'complaint' = 'bounce') {
  await env.DB.prepare('INSERT INTO email_suppressions (email, org_id, reason, created_at) VALUES (?, ?, ?, 0)')
    .bind(email, orgId, reason)
    .run();
}

export async function emailsUsedToday(orgId: string, now = Date.now()) {
  const row = await env.DB.prepare(
    "SELECT count FROM usage_counters WHERE org_id = ? AND metric = 'emails' AND day = ?",
  )
    .bind(orgId, new Date(now).toISOString().slice(0, 10))
    .first<{ count: number }>();
  return row?.count ?? 0;
}
