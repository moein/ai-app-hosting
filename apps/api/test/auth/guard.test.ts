import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema';
import { runTool } from '../../src/mcp/pipeline';
import { whoami } from '../../src/tools/auth/whoami';
import { privateEcho, signIn, testContext } from '../mcp/helpers';

const errorOf = (r: Awaited<ReturnType<typeof runTool>>) => (r.structuredContent as { error: { code: string } }).error;

describe('identity from the token (AUTH-3.6, AUTH-4.7)', () => {
  it('whoami returns the signed-in email and member_since', async () => {
    const ctx = testContext();
    await signIn(ctx, { email: 'me@example.com' });
    const result = await runTool(whoami, {}, ctx);
    expect(result.structuredContent).toEqual({
      email: 'me@example.com',
      member_since: new Date(ctx.clock.now()).toISOString(),
    });
  });

  it('every tool needs a user: none → AUTH_REQUIRED, blocked → ACCOUNT_BLOCKED', async () => {
    expect(errorOf(await runTool(privateEcho, { message: 'hi' }, testContext())).code).toBe('AUTH_REQUIRED');
    const ctx = testContext();
    const { userId } = await signIn(ctx);
    expect((await runTool(privateEcho, { message: 'hi' }, ctx)).isError).toBeUndefined();
    await ctx.db.update(users).set({ status: 'blocked' }).where(eq(users.id, userId));
    expect(errorOf(await runTool(privateEcho, { message: 'hi' }, ctx)).code).toBe('ACCOUNT_BLOCKED');
    await ctx.db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => {});
  });

  it('a token for a user that no longer exists → AUTH_REQUIRED', async () => {
    const ctx = testContext();
    ctx.userId = 'usr_doesnotexist' as never;
    ctx.orgId = 'org_doesnotexist' as never;
    expect(errorOf(await runTool(privateEcho, { message: 'hi' }, ctx)).code).toBe('AUTH_REQUIRED');
  });
});
