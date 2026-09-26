import { LOGIN_CODE_MAX_ATTEMPTS, type OrgId, PlatformError, type UserId } from '@repo/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashesEqual, hashLoginCode } from '../../auth/codes';
import { signUp } from '../../auth/signup';
import { loginCodes, memberships, users } from '../../db/schema';
import { defineTool } from '../../mcp/tool';

export const verifyLoginCode = defineTool({
  name: 'verify_login_code',
  description:
    'Step 2 of signing up or logging in: checks the 6-digit code the user received by email. On success this conversation is logged in (new users get an account automatically). Works without login.',
  public: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .pipe(z.email())
      .describe('The same email used in request_login_code.'),
    code: z
      .string()
      .transform((value) => value.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, 'Must be the 6-digit code from the email.'))
      .describe('The 6-digit code from the email.'),
  }),
  output: z.object({
    authenticated: z.literal(true),
    email: z.string(),
    is_new_user: z.boolean(),
    next_step: z.string(),
  }),
  handler: async ({ email, code }, ctx) => {
    const now = ctx.clock.now();
    const row = await ctx.db
      .select()
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt), isNull(loginCodes.invalidatedAt)))
      .orderBy(desc(loginCodes.createdAt))
      .get();
    if (!row) throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: 0 } });
    if (row.expiresAt <= now) throw new PlatformError('CODE_EXPIRED');

    if (!hashesEqual(await hashLoginCode(ctx.env.LOGIN_CODE_PEPPER, email, code), row.codeHash)) {
      const updated = await ctx.db
        .update(loginCodes)
        .set({ attempts: sql`${loginCodes.attempts} + 1` })
        .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt)))
        .returning({ attempts: loginCodes.attempts })
        .get();
      const attempts = updated?.attempts ?? LOGIN_CODE_MAX_ATTEMPTS;
      if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        await ctx.db.update(loginCodes).set({ invalidatedAt: now }).where(eq(loginCodes.id, row.id));
        throw new PlatformError('CODE_ATTEMPTS_EXCEEDED');
      }
      throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: LOGIN_CODE_MAX_ATTEMPTS - attempts } });
    }

    // Single use even under concurrency (AUTH-2.1).
    const consumed = await ctx.db
      .update(loginCodes)
      .set({ consumedAt: now })
      .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.consumedAt)))
      .returning({ id: loginCodes.id })
      .get();
    if (!consumed) throw new PlatformError('CODE_INVALID', { details: { attempts_remaining: 0 } });

    let identity: { userId: UserId; orgId: OrgId };
    let isNewUser = false;
    const user = await ctx.db.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      identity = await signUp(ctx, email);
      isNewUser = true;
    } else {
      if (user.status === 'blocked') throw new PlatformError('ACCOUNT_BLOCKED');
      await ctx.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      const membership = await ctx.db
        .select({ orgId: memberships.orgId })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .orderBy(memberships.createdAt)
        .get();
      if (!membership) throw new PlatformError('INTERNAL', { message: 'User has no organization.' });
      identity = { userId: user.id as UserId, orgId: membership.orgId as OrgId };
    }

    await ctx.session.setAuth({ ...identity, authenticatedAt: now, lastSeenAt: now });
    return {
      authenticated: true as const,
      email,
      is_new_user: isNewUser,
      next_step:
        'Call get_platform_guide before writing any code, then create_app (or list_apps to continue an existing app).',
    };
  },
});
