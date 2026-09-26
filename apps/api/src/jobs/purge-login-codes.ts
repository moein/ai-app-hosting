import { lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { loginCodes } from '../db/schema';

export const LOGIN_CODE_RETENTION_MS = 7 * 86_400_000;

/** Daily hygiene: login codes older than 7 days are deleted (spec 02 design). */
export async function purgeLoginCodes(db: Db, now: number): Promise<number> {
  const deleted = await db
    .delete(loginCodes)
    .where(lt(loginCodes.createdAt, now - LOGIN_CODE_RETENTION_MS))
    .returning({ id: loginCodes.id })
    .all();
  return deleted.length;
}
