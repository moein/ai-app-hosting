// Plain SQL over the platform D1 (the api owns the schema: apps/api/src/db/schema.ts, migrations in apps/api/migrations).

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

export type EmailStatus = 'pending' | 'ready' | 'failed';

export async function findApp(db: D1Database, appId: string) {
  return db
    .prepare('SELECT name, slug, org_id, status, email_status FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ name: string; slug: string; org_id: string; status: 'active' | 'deleted'; email_status: EmailStatus }>();
}

export async function setAppEmailStatus(db: D1Database, appId: string, status: 'ready' | 'failed') {
  await db.prepare('UPDATE apps SET email_status = ? WHERE id = ?').bind(status, appId).run();
}

export async function tenantStatus(db: D1Database, orgId: string) {
  const row = await db
    .prepare('SELECT email_tenant_status AS status FROM organizations WHERE id = ?')
    .bind(orgId)
    .first<{ status: 'pending' | 'ready' | 'failed' }>();
  return row?.status ?? null;
}

export async function setTenantStatus(db: D1Database, orgId: string, status: 'ready' | 'failed') {
  await db.prepare('UPDATE organizations SET email_tenant_status = ? WHERE id = ?').bind(status, orgId).run();
}

/** Recipients suppressed globally or for this org (MAIL-2.5). */
export async function suppressedAmong(db: D1Database, orgId: string, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const placeholders = emails.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT DISTINCT email FROM email_suppressions WHERE email IN (${placeholders}) AND (org_id IS NULL OR org_id = ?)`,
    )
    .bind(...emails, orgId)
    .all<{ email: string }>();
  return new Set(results.map((row) => row.email));
}

/** Atomic check-and-add on today's `emails` counter (same statement as the api's consumeDaily, APP-5.2). */
export async function consumeEmails(db: D1Database, orgId: string, amount: number, max: number, now: number) {
  if (amount > max) return false;
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (org_id, metric, day, count) VALUES (?, 'emails', ?, ?)
       ON CONFLICT (org_id, metric, day) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ?
       RETURNING count`,
    )
    .bind(orgId, dayOf(now), amount, max)
    .first<{ count: number }>();
  return row !== null;
}

export async function refundEmails(db: D1Database, orgId: string, amount: number, now: number) {
  await db
    .prepare("UPDATE usage_counters SET count = max(count - ?, 0) WHERE org_id = ? AND metric = 'emails' AND day = ?")
    .bind(amount, orgId, dayOf(now))
    .run();
}

/** Adds to an app's usage for a UTC day (spec 13, `add` metrics such as `emails`). */
export async function addAppUsage(
  db: D1Database,
  row: { appId: string; orgId: string; day: string; metric: string; quantity: number; now: number },
) {
  await db
    .prepare(
      `INSERT INTO app_usage_daily (app_id, org_id, day, metric, quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, day, metric) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
    )
    .bind(row.appId, row.orgId, row.day, row.metric, row.quantity, row.now)
    .run();
}
