import { generateSlug, newId, type OrgId, orgNameFromEmail, type UserId } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { memberships, organizations, users } from '../db/schema';
import type { ToolContext } from '../mcp/tool';

const MAX_SLUG_RACES = 3;

/**
 * Creates the user, their personal org and the owner membership in one D1 batch (AUTH-2.4), retrying with a new
 * slug if another signup took it concurrently (SLUG-3.3), then queues the org's SES tenant (spec 11).
 */
export async function signUp(ctx: ToolContext, email: string): Promise<{ userId: UserId; orgId: OrgId }> {
  const userId = newId('usr');
  const orgId = newId('org');
  const now = ctx.clock.now();
  const name = orgNameFromEmail(email);
  const isTaken = async (slug: string) =>
    (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).get()) !==
    undefined;

  for (let attempt = 1; ; attempt++) {
    const slug = await generateSlug(name, 'org', isTaken, ctx.random);
    try {
      await ctx.db.batch([
        ctx.db.insert(users).values({ id: userId, email, createdAt: now, lastLoginAt: now }),
        ctx.db.insert(organizations).values({ id: orgId, slug, name, createdAt: now, updatedAt: now }),
        ctx.db.insert(memberships).values({ orgId, userId, createdAt: now }),
      ]);
      break;
    } catch (error) {
      const slugRace = String(error).includes('organizations.slug');
      if (!slugRace || attempt >= MAX_SLUG_RACES) throw error;
    }
  }

  await ctx.emailJobs.send({ type: 'org.provision_email_tenant', orgId });
  return { userId, orgId };
}
