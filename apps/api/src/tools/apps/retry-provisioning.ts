import { PlatformError } from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { AppSummarySchema, toAppSummary } from '../../apps/summary';
import { apps } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { nextStepFor, waitForProvisioning } from './create-app';

export const retryProvisioning = defineTool({
  name: 'retry_provisioning',
  title: 'Retry app setup',
  description: 'Retries setting up an app whose setup failed (get_app shows provisioning "failed").',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ app: z.string().describe('The app slug.') }),
  output: AppSummarySchema.extend({ next_step: z.string() }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app);
    if (app.provisioning !== 'failed') {
      throw new PlatformError('CONFLICT', {
        message: `Setup of "${app.slug}" is ${app.provisioning}, not failed.`,
        hint: 'Only failed setups can be retried. Call get_app to see the current state.',
      });
    }
    await ctx.db.update(apps).set({ provisioning: 'pending', provisioningError: null }).where(eq(apps.id, app.id));
    await ctx.provisioner.start(app.id);
    const updated = await waitForProvisioning(ctx, app.id);
    return {
      ...(await toAppSummary(ctx.db, updated, ctx.env.APPS_DOMAIN)),
      next_step: nextStepFor(updated.provisioning),
    };
  },
});
