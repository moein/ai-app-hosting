import {
  LOGIN_CODE_TTL_MS,
  LOGIN_CODES_PER_EMAIL_PER_DAY,
  LOGIN_CODES_PER_EMAIL_PER_HOUR,
  LOGIN_CODES_PER_SESSION_PER_10_MIN,
  newId,
  PlatformError,
  platformErrorFromJson,
} from '@repo/shared';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { generateLoginCode, hashLoginCode } from '../../auth/codes';
import { emailSuppressions, loginCodes } from '../../db/schema';
import { defineTool, type ToolContext } from '../../mcp/tool';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SESSION_WINDOW_MS = 10 * 60_000;

const rateLimited = (retryAfterMs: number) =>
  new PlatformError('RATE_LIMITED', { details: { retry_after_seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } });

async function checkEmailLimits(ctx: ToolContext, email: string, now: number) {
  const recent = await ctx.db
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

export const requestLoginCode = defineTool({
  name: 'request_login_code',
  description:
    "Step 1 of signing up or logging in: emails a 6-digit code to the user's address. Ask the user for their email first, then call this, then ask them for the code and call verify_login_code. Works without login.",
  public: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).describe("The user's email address."),
  }),
  output: z.object({
    sent: z.literal(true),
    email: z.string(),
    expires_in_seconds: z.number(),
    next_step: z.string(),
  }),
  handler: async ({ email }, ctx) => {
    const now = ctx.clock.now();

    // Per-session limit, kept in the session Durable Object (AUTH-1.6).
    const sessionRequests = await ctx.session.recentLoginCodeRequests(now - SESSION_WINDOW_MS);
    if (sessionRequests.length >= LOGIN_CODES_PER_SESSION_PER_10_MIN) {
      throw rateLimited((sessionRequests[0] as number) + SESSION_WINDOW_MS - now);
    }

    // Addresses that hard-bounced can't receive the code (AUTH-1.7).
    const suppressed = await ctx.db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.email, email), isNull(emailSuppressions.orgId)))
      .get();
    if (suppressed) throw new PlatformError('EMAIL_UNDELIVERABLE');

    await checkEmailLimits(ctx, email, now);

    // Only the newest code is valid (AUTH-1.5); only its hash is stored (AUTH-1.4).
    const code = generateLoginCode(ctx.random);
    const codeId = newId('lc');
    await ctx.db.batch([
      ctx.db
        .update(loginCodes)
        .set({ invalidatedAt: now })
        .where(and(eq(loginCodes.email, email), isNull(loginCodes.consumedAt), isNull(loginCodes.invalidatedAt))),
      ctx.db.insert(loginCodes).values({
        id: codeId,
        email,
        codeHash: await hashLoginCode(ctx.env.LOGIN_CODE_PEPPER, email, code),
        createdAt: now,
        expiresAt: now + LOGIN_CODE_TTL_MS,
      }),
    ]);

    const sent = await ctx.mailer.sendLoginCode({ to: email, code, codeId });
    if (!sent.ok) {
      await ctx.db.update(loginCodes).set({ invalidatedAt: now }).where(eq(loginCodes.id, codeId));
      throw platformErrorFromJson(sent.error); // AUTH-1.9
    }
    await ctx.session.recordLoginCodeRequest(now);

    return {
      sent: true as const,
      email,
      expires_in_seconds: LOGIN_CODE_TTL_MS / 1000,
      next_step: `Ask the user for the 6-digit code we just emailed to ${email}, then call verify_login_code.`,
    };
  },
});
