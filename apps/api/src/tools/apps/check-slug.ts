import { validateSlug } from '@repo/shared';
import { z } from 'zod';
import { isAppSlugTaken, suggestSlug } from '../../apps/insert';
import { defineTool } from '../../mcp/tool';

export const checkSlug = defineTool({
  name: 'check_slug',
  description:
    'Checks whether an app address (the subdomain part, e.g. "my-todo") is valid and still free, and suggests one if it isn\'t.',
  public: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ slug: z.string().max(100).describe('The address to check, e.g. "my-todo".') }),
  output: z.object({
    slug: z.string(),
    valid: z.boolean(),
    available: z.boolean(),
    reason: z.string().optional(),
    suggestion: z.string().optional(),
  }),
  handler: async ({ slug }, ctx) => {
    const validity = validateSlug(slug);
    if (!validity.ok) {
      return {
        slug,
        valid: false,
        available: false,
        reason: validity.reason,
        suggestion: await suggestSlug(ctx, slug),
      };
    }
    if (await isAppSlugTaken(ctx, slug)) {
      return { slug, valid: true, available: false, suggestion: await suggestSlug(ctx, slug) };
    }
    return { slug, valid: true, available: true };
  },
});
