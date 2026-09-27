import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailSuppressions } from '../db/schema';

export type Suppression = { email: string; orgId: string | null; reason: 'bounce' | 'complaint'; now: number };

/**
 * Idempotent suppression upsert (MAIL-4.6). SQLite treats NULLs as distinct in UNIQUE, so global rows
 * (org_id NULL) use INSERT … WHERE NOT EXISTS; org rows rely on UNIQUE (email, org_id).
 */
export async function suppress(db: Db, { email, orgId, reason, now }: Suppression): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (orgId === null) {
    await db.run(sql`
      INSERT INTO email_suppressions (email, org_id, reason, created_at)
      SELECT ${normalized}, NULL, ${reason}, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM email_suppressions WHERE email = ${normalized} AND org_id IS NULL)`);
    return;
  }
  await db.insert(emailSuppressions).values({ email: normalized, orgId, reason, createdAt: now }).onConflictDoNothing();
}
