import { CREATE_APP_WAIT_MS, PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { insertApp } from '../../apps/insert';
import { checkAppQuota } from '../../apps/quota';
import { AppSummarySchema, toAppSummary } from '../../apps/summary';
import { apps } from '../../db/schema';
import { defineTool, type ToolContext } from '../../mcp/tool';

const POLL_MS = 1_000;

/** Waits (bounded) for ProvisionApp to finish so most calls return a ready app (APP-2.4). */
export async function waitForProvisioning(ctx: ToolContext, appId: string) {
  const deadline = ctx.clock.now() + CREATE_APP_WAIT_MS;
  for (;;) {
    const app = await ctx.db.select().from(apps).where(eq(apps.id, appId)).get();
    if (!app) throw new PlatformError('INTERNAL');
    if (app.provisioning !== 'pending' || ctx.clock.now() >= deadline) return app;
    await ctx.sleep(POLL_MS);
  }
}

export const nextStepFor = (provisioning: string) =>
  provisioning === 'ready'
    ? 'The repository is empty except for platform-managed files. Follow get_platform_guide, write the app with write_files, then watch the deployment with get_deployment.'
    : provisioning === 'failed'
      ? 'Setup failed. Call retry_provisioning.'
      : 'Setup is still running. Call get_app in a few seconds.';

export const createApp = defineTool({
  name: 'create_app',
  title: 'Create an app',
  description:
    'Creates a new app: an empty code repository, a database and an address https://<slug>.<apps domain>. The platform writes no code — you write every file with write_files, following get_platform_guide.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: z.object({
    name: z.string().describe('Human-readable app name, e.g. "Family Recipes".'),
    slug: z
      .string()
      .optional()
      .describe('Optional address; generated from the name when omitted. Check it with check_slug.'),
  }),
  output: AppSummarySchema.extend({ next_step: z.string() }),
  handler: async (input, ctx) => {
    const name = input.name.trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new PlatformError('NAME_INVALID');
    }
    await checkAppQuota(ctx.db, ctx.orgId as string);
    const inserted = await insertApp(ctx, { name, slug: input.slug });
    ctx.app = { id: inserted.id, slug: inserted.slug };
    await ctx.provisioner.start(inserted.id);
    const app = await waitForProvisioning(ctx, inserted.id);
    return { ...(await toAppSummary(ctx.db, app, ctx.env.APPS_DOMAIN)), next_step: nextStepFor(app.provisioning) };
  },
});
