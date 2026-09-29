import { env } from 'cloudflare:workers';
import { cryptoRandom, LOGIN_CODE_TTL_MS, type PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { issueLoginCode, type LoginDeps, verifyLoginCode } from '../../src/auth/login-codes';
import { createDb } from '../../src/db/client';
import { emailSuppressions, loginCodes, memberships, organizations, users } from '../../src/db/schema';
import { fakeClock, fakeMailer, fakeQueue, signIn, testContext } from '../mcp/helpers';

let seq = 0;
const freshEmail = () => `user${++seq}-${Date.now()}@example.com`;

function setup() {
  const mailer = fakeMailer();
  const emailJobs = fakeQueue();
  const clock = fakeClock();
  const deps: LoginDeps = {
    db: createDb(env.DB),
    random: cryptoRandom,
    pepper: env.LOGIN_CODE_PEPPER,
    mailer,
    emailJobs,
  };
  const lastCode = () => mailer.sent.at(-1)?.code ?? '';
  const issue = (email: string) => issueLoginCode(deps, email, clock.now());
  const verify = (email: string, code: string) => verifyLoginCode(deps, email, code, clock.now());
  return { deps, mailer, emailJobs, clock, lastCode, issue, verify };
}
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as PlatformError;
  }
  throw new Error('expected an error');
};
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('issueLoginCode (AUTH-1)', () => {
  it('emails a 6-digit code and stores only its hash with a 10-minute expiry (AUTH-1.1, AUTH-1.4)', async () => {
    const { deps, mailer, clock, issue } = setup();
    const email = freshEmail();
    await issue(email);
    const sent = mailer.sent[0];
    expect(sent?.to).toBe(email);
    expect(sent?.code).toMatch(/^\d{6}$/);
    const row = await deps.db
      .select()
      .from(loginCodes)
      .where(eq(loginCodes.id, sent?.codeId ?? ''))
      .get();
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(sent?.code);
    expect(row?.expiresAt).toBe(clock.now() + LOGIN_CODE_TTL_MS);
  });

  it('invalidates the previous code when a new one is issued (AUTH-1.5)', async () => {
    const { issue, verify, lastCode, clock } = setup();
    const email = freshEmail();
    await issue(email);
    const first = lastCode();
    clock.advance(1_000);
    await issue(email);
    expect((await codeOf(verify(email, first))).code).toBe('CODE_INVALID');
  });

  it('limits 5 codes per email per hour and 20 per day (AUTH-1.6)', async () => {
    const { issue, clock } = setup();
    const email = freshEmail();
    for (let i = 0; i < 5; i++) {
      await issue(email);
      clock.advance(60_000);
    }
    const hourly = await codeOf(issue(email));
    expect(hourly.code).toBe('RATE_LIMITED');
    expect(hourly.details?.retry_after_seconds).toBe(3_600 - 5 * 60);
    for (let hour = 0; hour < 3; hour++) {
      clock.advance(3_600_000);
      for (let i = 0; i < 5; i++) {
        await issue(email);
        clock.advance(60_000);
      }
    }
    clock.advance(3_600_000);
    expect((await codeOf(issue(email))).code).toBe('RATE_LIMITED');
  });

  it('refuses globally suppressed addresses without sending (AUTH-1.7)', async () => {
    const { deps, issue, mailer } = setup();
    const email = freshEmail();
    await deps.db.insert(emailSuppressions).values({ email, reason: 'bounce', createdAt: 0 });
    expect((await codeOf(issue(email))).code).toBe('EMAIL_UNDELIVERABLE');
    expect(mailer.sent).toHaveLength(0);
  });

  it('invalidates the code when sending fails (AUTH-1.9)', async () => {
    const { deps, issue, mailer } = setup();
    const email = freshEmail();
    mailer.fail = { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'down', hint: 'retry', retryable: true } };
    expect((await codeOf(issue(email))).code).toBe('UPSTREAM_ERROR');
    const rows = await deps.db.select().from(loginCodes).where(eq(loginCodes.email, email)).all();
    expect(rows.every((row) => row.invalidatedAt !== null)).toBe(true);
  });
});

describe('verifyLoginCode (AUTH-2)', () => {
  it('signs up a new email: user, personal org, owner membership, tenant job (AUTH-2.1, AUTH-2.4)', async () => {
    const { deps, issue, verify, lastCode, emailJobs } = setup();
    const email = `moein+${Date.now()}@tropee.com`;
    await issue(email);
    const code = lastCode();
    const result = await verify(email, ` ${code.slice(0, 3)}-${code.slice(3)} `);
    expect(result.isNewUser).toBe(true);
    const user = await deps.db.select().from(users).where(eq(users.email, email)).get();
    expect(user?.id).toBe(result.userId);
    const membership = await deps.db.select().from(memberships).where(eq(memberships.userId, result.userId)).all();
    expect(membership).toEqual([expect.objectContaining({ orgId: result.orgId, role: 'owner' })]);
    const org = await deps.db.select().from(organizations).where(eq(organizations.id, result.orgId)).get();
    expect(org?.slug).toMatch(/^moein(-[0-9a-z]{4})?$/);
    expect(emailJobs.messages).toEqual([{ type: 'org.provision_email_tenant', orgId: result.orgId }]);
  });

  it('signs in an existing user and updates last_login_at (AUTH-2.8)', async () => {
    const email = freshEmail();
    const { userId, orgId } = await signIn(testContext(), { email });
    const { deps, issue, verify, lastCode, clock, emailJobs } = setup();
    clock.advance(5_000);
    await issue(email);
    expect(await verify(email, lastCode())).toEqual({ userId, orgId, isNewUser: false });
    expect((await deps.db.select().from(users).where(eq(users.id, userId)).get())?.lastLoginAt).toBe(clock.now());
    expect(emailJobs.messages).toEqual([]);
  });

  it('counts wrong codes and locks after 5 attempts (AUTH-2.3, AUTH-2.7)', async () => {
    const { issue, verify, lastCode } = setup();
    const email = freshEmail();
    await issue(email);
    const bad = wrong(lastCode());
    for (let remaining = 4; remaining >= 1; remaining--) {
      expect(await codeOf(verify(email, bad))).toMatchObject({
        code: 'CODE_INVALID',
        details: { attempts_remaining: remaining },
      });
    }
    expect((await codeOf(verify(email, bad))).code).toBe('CODE_ATTEMPTS_EXCEEDED');
    expect((await codeOf(verify(email, lastCode()))).code).toBe('CODE_INVALID');
  });

  it('rejects expired codes, non-numeric input and emails without a code (AUTH-2.5, AUTH-2.6)', async () => {
    const { issue, verify, lastCode, clock } = setup();
    const email = freshEmail();
    await issue(email);
    expect((await codeOf(verify(email, 'abcdef'))).code).toBe('CODE_INVALID');
    clock.advance(LOGIN_CODE_TTL_MS);
    expect((await codeOf(verify(email, lastCode()))).code).toBe('CODE_EXPIRED');
    expect(await codeOf(verify(freshEmail(), '123456'))).toMatchObject({
      code: 'CODE_INVALID',
      details: { attempts_remaining: 0 },
    });
  });

  it('consumes a code only once, even concurrently', async () => {
    const { deps, issue, verify, lastCode } = setup();
    const email = freshEmail();
    await issue(email);
    const results = await Promise.allSettled([verify(email, lastCode()), verify(email, lastCode())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await deps.db.select().from(users).where(eq(users.email, email)).all()).toHaveLength(1);
  });

  it('refuses blocked users (AUTH-2.10)', async () => {
    const email = freshEmail();
    await signIn(testContext(), { email, status: 'blocked' });
    const { issue, verify, lastCode } = setup();
    await issue(email);
    expect((await codeOf(verify(email, lastCode()))).code).toBe('ACCOUNT_BLOCKED');
  });
});
