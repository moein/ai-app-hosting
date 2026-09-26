import { LOGIN_CODE_TTL_MS, SESSION_IDLE_TTL_MS } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailSuppressions, loginCodes, memberships, organizations, users } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { logout } from '../../src/tools/auth/logout';
import { requestLoginCode } from '../../src/tools/auth/request-login-code';
import { verifyLoginCode } from '../../src/tools/auth/verify-login-code';
import { whoami } from '../../src/tools/auth/whoami';
import { signIn, type TestContext, testContext } from '../mcp/helpers';

type ErrorJson = { code: string; hint: string; details?: Record<string, unknown> };
const errorOf = (result: Awaited<ReturnType<typeof runTool>>) =>
  (result.structuredContent as { error: ErrorJson }).error;
const data = <T>(result: Awaited<ReturnType<typeof runTool>>) => {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent as T;
};

let seq = 0;
const freshEmail = () => `user${++seq}-${Date.now()}@example.com`;
const request = (ctx: TestContext, email: string) => runTool(requestLoginCode, { email }, ctx);
const verify = (ctx: TestContext, email: string, code: string) => runTool(verifyLoginCode, { email, code }, ctx);
const lastCode = (ctx: TestContext) => ctx.mailer.sent.at(-1)?.code ?? '';
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('request_login_code (AUTH-1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emails a 6-digit code, stores only its hash, and returns the documented shape', async () => {
    const ctx = testContext();
    const email = freshEmail();
    const result = data<{ sent: boolean; email: string; expires_in_seconds: number; next_step: string }>(
      await request(ctx, `  ${email.toUpperCase()} `),
    );
    expect(result).toMatchObject({ sent: true, email, expires_in_seconds: LOGIN_CODE_TTL_MS / 1000 });
    expect(result.next_step).toContain('verify_login_code');
    const sent = ctx.mailer.sent[0];
    expect(sent?.to).toBe(email);
    expect(sent?.code).toMatch(/^\d{6}$/);
    const row = await ctx.db
      .select()
      .from(loginCodes)
      .where(eq(loginCodes.id, sent?.codeId ?? ''))
      .get();
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(sent?.code);
    expect(row?.expiresAt).toBe(ctx.clock.now() + LOGIN_CODE_TTL_MS);
  });

  it('rejects invalid emails with INVALID_INPUT', async () => {
    expect(errorOf(await request(testContext(), 'not-an-email')).code).toBe('INVALID_INPUT');
  });

  it('responds identically for registered and unregistered emails (AUTH-1.3)', async () => {
    const ctx = testContext();
    const registered = freshEmail();
    await signIn(testContext(), { email: registered });
    const a = data<Record<string, unknown>>(await request(ctx, registered));
    const b = data<Record<string, unknown>>(await request(testContext(), freshEmail()));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.next_step).toBe(String(b.next_step).replace(String(b.email), String(a.email)));
  });

  it('invalidates the previous code when a new one is issued (AUTH-1.5)', async () => {
    const ctx = testContext();
    const email = freshEmail();
    await request(ctx, email);
    const first = lastCode(ctx);
    ctx.clock.advance(1_000);
    await request(testContext({ clock: ctx.clock }), email);
    expect(errorOf(await verify(ctx, email, first)).code).toBe('CODE_INVALID');
  });

  it('limits 3 codes per session per 10 minutes (AUTH-1.6)', async () => {
    const ctx = testContext();
    for (let i = 0; i < 3; i++) data(await request(ctx, freshEmail()));
    const error = errorOf(await request(ctx, freshEmail()));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.details?.retry_after_seconds).toBe(600);
    ctx.clock.advance(10 * 60_000);
    data(await request(ctx, freshEmail()));
    expect(ctx.mailer.sent).toHaveLength(4);
  });

  it('limits 5 codes per email per hour and 20 per day (AUTH-1.6)', async () => {
    const clock = testContext().clock;
    const email = freshEmail();
    const fromNewSession = () => request(testContext({ clock }), email);
    for (let i = 0; i < 5; i++) {
      data(await fromNewSession());
      clock.advance(60_000);
    }
    const hourly = errorOf(await fromNewSession());
    expect(hourly.code).toBe('RATE_LIMITED');
    expect(hourly.details?.retry_after_seconds).toBe(3_600 - 5 * 60);

    for (let hour = 0; hour < 3; hour++) {
      clock.advance(3_600_000);
      for (let i = 0; i < 5; i++) {
        data(await fromNewSession());
        clock.advance(60_000);
      }
    }
    clock.advance(3_600_000);
    expect(errorOf(await fromNewSession()).code).toBe('RATE_LIMITED');
  });

  it('refuses globally suppressed addresses without sending (AUTH-1.7)', async () => {
    const ctx = testContext();
    const email = freshEmail();
    await ctx.db.insert(emailSuppressions).values({ email, reason: 'bounce', createdAt: 0 });
    expect(errorOf(await request(ctx, email)).code).toBe('EMAIL_UNDELIVERABLE');
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('invalidates the code and does not count the request when sending fails (AUTH-1.9)', async () => {
    const ctx = testContext();
    const email = freshEmail();
    ctx.mailer.fail = {
      ok: false,
      error: { code: 'UPSTREAM_ERROR', message: 'down', hint: 'retry', retryable: true },
    };
    expect(errorOf(await request(ctx, email)).code).toBe('UPSTREAM_ERROR');
    const rows = await ctx.db.select().from(loginCodes).where(eq(loginCodes.email, email)).all();
    expect(rows.every((row) => row.invalidatedAt !== null)).toBe(true);
    expect(await ctx.session.recentLoginCodeRequests(0)).toEqual([]);
  });
});

describe('verify_login_code (AUTH-2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('signs up a new email: user, personal org, owner membership, tenant job, session bound (AUTH-2.1, AUTH-2.4)', async () => {
    const ctx = testContext();
    const email = `moein+${Date.now()}@tropee.com`;
    await request(ctx, email);
    const result = data<{ authenticated: boolean; is_new_user: boolean; next_step: string }>(
      await verify(ctx, email, ` ${lastCode(ctx).slice(0, 3)}-${lastCode(ctx).slice(3)} `),
    );
    expect(result).toMatchObject({ authenticated: true, is_new_user: true });
    expect(result.next_step).toContain('get_platform_guide');

    const user = await ctx.db.select().from(users).where(eq(users.email, email)).get();
    const membership = await ctx.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user?.id ?? ''))
      .all();
    expect(membership).toHaveLength(1);
    expect(membership[0]?.role).toBe('owner');
    const org = await ctx.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, membership[0]?.orgId ?? ''))
      .get();
    expect(org?.slug).toMatch(/^moein(-[0-9a-z]{4})?$/);
    expect(org?.emailTenantStatus).toBe('pending');
    expect(ctx.emailJobs.messages).toEqual([{ type: 'org.provision_email_tenant', orgId: org?.id }]);
    expect(await ctx.session.getAuth()).toMatchObject({ userId: user?.id, orgId: org?.id });
  });

  it('signs in an existing user, updates last_login_at and binds their org (AUTH-2.8)', async () => {
    const email = freshEmail();
    const { userId, orgId } = await signIn(testContext(), { email });
    const ctx = testContext();
    ctx.clock.advance(5_000);
    await request(ctx, email);
    const result = data<{ is_new_user: boolean }>(await verify(ctx, email, lastCode(ctx)));
    expect(result.is_new_user).toBe(false);
    expect(await ctx.session.getAuth()).toMatchObject({ userId, orgId });
    const user = await ctx.db.select().from(users).where(eq(users.id, userId)).get();
    expect(user?.lastLoginAt).toBe(ctx.clock.now());
    expect(ctx.emailJobs.messages).toEqual([]);
  });

  it('counts wrong codes and locks after 5 attempts (AUTH-2.3, AUTH-2.7)', async () => {
    const ctx = testContext();
    const email = freshEmail();
    await request(ctx, email);
    const bad = wrong(lastCode(ctx));
    for (let remaining = 4; remaining >= 1; remaining--) {
      const error = errorOf(await verify(ctx, email, bad));
      expect(error).toMatchObject({ code: 'CODE_INVALID', details: { attempts_remaining: remaining } });
    }
    expect(errorOf(await verify(ctx, email, bad)).code).toBe('CODE_ATTEMPTS_EXCEEDED');
    expect(errorOf(await verify(ctx, email, lastCode(ctx))).code).toBe('CODE_INVALID');
  });

  it('rejects expired codes and emails without a code (AUTH-2.5, AUTH-2.6)', async () => {
    const ctx = testContext();
    const email = freshEmail();
    await request(ctx, email);
    ctx.clock.advance(LOGIN_CODE_TTL_MS);
    expect(errorOf(await verify(ctx, email, lastCode(ctx))).code).toBe('CODE_EXPIRED');
    expect(errorOf(await verify(ctx, freshEmail(), '123456'))).toMatchObject({
      code: 'CODE_INVALID',
      details: { attempts_remaining: 0 },
    });
  });

  it('consumes a code only once, even concurrently', async () => {
    const ctx = testContext();
    const email = freshEmail();
    await request(ctx, email);
    const code = lastCode(ctx);
    const results = await Promise.all([
      verify(ctx, email, code),
      verify(testContext({ clock: ctx.clock }), email, code),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(await ctx.db.select().from(users).where(eq(users.email, email)).all()).toHaveLength(1);
  });

  it('switches the session to another user (AUTH-2.9)', async () => {
    const ctx = testContext();
    const first = await signIn(ctx);
    const email = freshEmail();
    await request(ctx, email);
    await verify(ctx, email, lastCode(ctx));
    const auth = await ctx.session.getAuth();
    expect(auth?.userId).not.toBe(first.userId);
  });

  it('refuses blocked users (AUTH-2.10)', async () => {
    const email = freshEmail();
    await signIn(testContext(), { email, status: 'blocked' });
    const ctx = testContext();
    await request(ctx, email);
    expect(errorOf(await verify(ctx, email, lastCode(ctx))).code).toBe('ACCOUNT_BLOCKED');
    expect(await ctx.session.getAuth()).toBeNull();
  });
});

describe('session binding: whoami, logout, guard (AUTH-3)', () => {
  it('whoami reports logged-out and logged-in states (AUTH-3.6)', async () => {
    const ctx = testContext();
    expect(data(await runTool(whoami, {}, ctx))).toEqual({
      authenticated: false,
      next_step: 'Ask the user for their email address, then call request_login_code.',
    });
    const email = freshEmail();
    await signIn(ctx, { email });
    expect(data(await runTool(whoami, {}, ctx))).toEqual({
      authenticated: true,
      email,
      member_since: new Date(ctx.clock.now()).toISOString(),
    });
  });

  it('logout needs a login and clears the binding (AUTH-3.4, AUTH-3.5)', async () => {
    const ctx = testContext();
    const anonymous = errorOf(await runTool(logout, {}, ctx));
    expect(anonymous.code).toBe('AUTH_REQUIRED');
    expect(anonymous.hint).toContain('request_login_code');
    await signIn(ctx);
    expect(data(await runTool(logout, {}, ctx))).toEqual({ authenticated: false });
    expect(errorOf(await runTool(logout, {}, ctx)).code).toBe('AUTH_REQUIRED');
  });

  it('expires after 30 days idle and slides on use (AUTH-3.2)', async () => {
    const ctx = testContext();
    await signIn(ctx);
    ctx.clock.advance(SESSION_IDLE_TTL_MS - 1);
    expect(
      (await runTool(logout, {}, testContext({ session: ctx.session, clock: ctx.clock }))).isError,
    ).toBeUndefined();

    const idle = testContext();
    await signIn(idle);
    idle.clock.advance(SESSION_IDLE_TTL_MS + 1);
    expect(data<{ authenticated: boolean }>(await runTool(whoami, {}, idle)).authenticated).toBe(false);
    expect(errorOf(await runTool(logout, {}, idle)).code).toBe('AUTH_REQUIRED');
    expect(await idle.session.getAuth()).toBeNull();
  });

  it('rejects and unbinds a user who became blocked (AUTH-3.7)', async () => {
    const ctx = testContext();
    const { userId } = await signIn(ctx);
    await ctx.db.update(users).set({ status: 'blocked' }).where(eq(users.id, userId));
    expect(errorOf(await runTool(logout, {}, ctx)).code).toBe('ACCOUNT_BLOCKED');
    expect(await ctx.session.getAuth()).toBeNull();
  });
});
