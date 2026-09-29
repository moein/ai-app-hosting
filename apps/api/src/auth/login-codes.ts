import {
  type EmailJob,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_MS,
  LOGIN_CODES_PER_EMAIL_PER_DAY,
  LOGIN_CODES_PER_EMAIL_PER_HOUR,
  newId,
  type OrgId,
  PlatformError,
  type PlatformMailRpc,
  platformErrorFromJson,
  type Random,
  type UserId,
} from '@repo/shared';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { emailSuppressions, loginCodes, memberships, users } from '../db/schema';
import { generateLoginCode, hashesEqual, hashLoginCode } from './codes';
import { signUp } from './signup';

/** What the login-code rules need (spec 02, AUTH-1/AUTH-2); the sign-in pages provide it. */
export type LoginDeps = {
  db: Db;
  random: Random;
  pepper: string;
  mailer: PlatformMailRpc;
  emailJobs: { send(job: EmailJob): Promise<unknown> };
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const rateLimited = (retryAfterMs: number) =>
  new PlatformError('RATE_LIMITED', { details: { retry_after_seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } });

async function checkEmailLimits(deps: LoginDeps, email: string, now: number) {
  const recent = await deps.db
    .select({ createdAt: loginCodes.createdAt })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gte(loginCodes.createdAt, now - DAY_MS)))
    .all();
  const times = recent.map((row) => row.createdAt).sort((a, b) => a - b);
  const lastHour = times.filter((at) => at >= now - HOUR_MS);
  if (lastHour.length >= LOGIN_CODES_PER_EMAIL_PER_HOUR) {
    throw rateLimited((lastHour[lastHour.length - LOGIN_CODES_PER_EMAIL_PER_HOUR] as number) + HOUR_MS - now);
  }
  if (times.length >= LOGIN_CODES_PER_EMAIL_PER_DAY) {
    throw rateLimited((times[times.length - LOGIN_CODES_PER_EMAIL_PER_DAY] as number) + DAY_MS - now);
  }
}

/**
 * Issues and emails a login code (AUTH-1.4–1.9). Throws RATE_LIMITED, EMAIL_UNDELIVERABLE or the mail error;
 * the caller applies its own per-sign-in and per-IP limits first.
 */
export async function issueLoginCode(deps: LoginDeps, email: string, now: number): Promise<void> {
  const suppressed = await deps.db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.email, email), isNull(emailSuppressions.orgId)))
    .get();
  if (suppressed) throw new PlatformError('EMAIL_UNDELIVERABLE');

  await checkEmailLimits(deps, email, now);

  // Only the newest code is valid (AUTH-1.5); only its hash is stored (AUTH-1.4).
  const code = generateLoginCode(deps.random);
  const codeId = newId('lc');
  await deps.db.batch([
    deps.db
      .update(loginCodes)
      .set({ invalidatedAt: now })
      .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt), isNull(loginCodes.invalidatedAt))),
    deps.db.insert(loginCodes).values({
      id: codeId,
      email,
      codeHash: await hashLoginCode(deps.pepper, email, code),
      createdAt: now,
      expiresAt: now + LOGIN_CODE_TTL_MS,
    }),
  ]);

  const sent = await deps.mailer.sendLoginCode({ to: email, code, codeId });
  if (!sent.ok) {
    await deps.db.update(loginCodes).set({ invalidatedAt: now }).where(eq(loginCodes.id, codeId));
    throw platformErrorFromJson(sent.error); // AUTH-1.9
  }
}

/**
 * Verifies a code and signs the person up or in (AUTH-2). Throws CODE_INVALID (with attempts_remaining),
 * CODE_EXPIRED, CODE_ATTEMPTS_EXCEEDED or ACCOUNT_BLOCKED.
 */
export async function verifyLoginCode(
  deps: LoginDeps,
  email: string,
  rawCode: string,
  now: number,
): Promise<{ userId: UserId; orgId: OrgId; isNewUser: boolean }> {
  const code = rawCode.replace(/[\s-]/g, '');
  const row = await deps.db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt), isNull(loginCodes.invalidatedAt)))
    .orderBy(desc(loginCodes.createdAt))
    .get();
  if (!row) throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: 0 } });
  if (row.expiresAt <= now) throw new PlatformError('CODE_EXPIRED');

  const matches = /^\d{6}$/.test(code) && hashesEqual(await hashLoginCode(deps.pepper, email, code), row.codeHash);
  if (!matches) {
    const updated = await deps.db
      .update(loginCodes)
      .set({ attempts: sql`${loginCodes.attempts} + 1` })
      .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt)))
      .returning({ attempts: loginCodes.attempts })
      .get();
    const attempts = updated?.attempts ?? LOGIN_CODE_MAX_ATTEMPTS;
    if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      await deps.db.update(loginCodes).set({ invalidatedAt: now }).where(eq(loginCodes.id, row.id));
      throw new PlatformError('CODE_ATTEMPTS_EXCEEDED');
    }
    throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: LOGIN_CODE_MAX_ATTEMPTS - attempts } });
  }

  // Single use even under concurrency (AUTH-2.1).
  const consumed = await deps.db
    .update(loginCodes)
    .set({ consumedAt: now })
    .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt)))
    .returning({ id: loginCodes.id })
    .get();
  if (!consumed) throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: 0 } });

  const user = await deps.db.select().from(users).where(eq(users.email, email)).get();
  if (!user) return { ...(await signUp({ ...deps, now }, email)), isNewUser: true };
  if (user.status === 'blocked') throw new PlatformError('ACCOUNT_BLOCKED');
  await deps.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  const membership = await deps.db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .orderBy(memberships.createdAt)
    .get();
  if (!membership) throw new PlatformError('INTERNAL', { message: 'User has no organization.' });
  return { userId: user.id as UserId, orgId: membership.orgId as OrgId, isNewUser: false };
}
