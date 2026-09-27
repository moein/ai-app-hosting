import { generateSlug, newId, PlatformError, validateSlug } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../db/errors';
import { apps } from '../db/schema';
import type { ToolContext } from '../mcp/tool';
import type { Environment } from '../platform';
import { appResourceNames } from './names';
import type { AppRow } from './resolve';

const MAX_SLUG_RACES = 3;

export const isAppSlugTaken = async (ctx: ToolContext, slug: string) =>
  (await ctx.db.select({ id: apps.id }).from(apps).where(eq(apps.slug, slug)).get()) !== undefined;

const isSlugConflict = (error: unknown) => isUniqueViolation(error, 'apps.slug');

/** A valid, available suggestion based on `input` (SLUG-4.1, SLUG-4.2). */
export const suggestSlug = (ctx: ToolContext, input: string) =>
  generateSlug(input, 'app', (slug) => isAppSlugTaken(ctx, slug), ctx.random);

/**
 * Inserts the app row. Generated slugs retry on a unique-index race; a requested slug that loses the race is
 * reported as SLUG_UNAVAILABLE (SLUG-3.3). Deleted apps keep their slugs (SLUG-3.2): the index covers them too.
 */
export async function insertApp(ctx: ToolContext, input: { name: string; slug?: string | undefined }): Promise<AppRow> {
  if (!ctx.orgId || !ctx.userId) throw new PlatformError('AUTH_REQUIRED');
  const environment = ctx.env.ENVIRONMENT as Environment;

  if (input.slug !== undefined) {
    const validity = validateSlug(input.slug);
    if (!validity.ok) {
      throw new PlatformError('SLUG_INVALID', {
        details: { reason: validity.reason, suggestion: await suggestSlug(ctx, input.slug) },
      });
    }
    if (await isAppSlugTaken(ctx, input.slug)) {
      throw new PlatformError('SLUG_UNAVAILABLE', { details: { suggestion: await suggestSlug(ctx, input.slug) } });
    }
  }

  for (let attempt = 1; ; attempt++) {
    const slug = input.slug ?? (await suggestSlug(ctx, input.name));
    const now = ctx.clock.now();
    const row = {
      id: newId('app'),
      orgId: ctx.orgId,
      slug,
      name: input.name,
      ...appResourceNames(slug, environment),
      repoOwner: ctx.env.GITHUB_ORG,
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await ctx.db.insert(apps).values(row).returning().get();
    } catch (error) {
      if (!isSlugConflict(error)) throw error;
      if (input.slug !== undefined) {
        throw new PlatformError('SLUG_UNAVAILABLE', { details: { suggestion: await suggestSlug(ctx, input.slug) } });
      }
      if (attempt >= MAX_SLUG_RACES) throw error;
    }
  }
}
