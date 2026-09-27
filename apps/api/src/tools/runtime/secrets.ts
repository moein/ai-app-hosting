import { MAX_SECRET_BYTES, MAX_SECRETS_PER_APP, PlatformError } from '@repo/shared';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { resolveApp } from '../../apps/resolve';
import { appSecrets } from '../../db/schema';
import { defineTool } from '../../mcp/tool';
import { liveVarNames, RESERVED_NAMES, SECRET_NAME } from '../../runtime/secrets';

const iso = (ms: number) => new Date(ms).toISOString();

export const setSecret = defineTool({
  name: 'set_secret',
  description:
    'Stores a secret (e.g. an API key) for the app; the app reads it as env.<NAME>. Ask the user for the value — never put secrets in code. Takes effect immediately, no redeploy needed.',
  public: false,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    app: z.string().describe('The app slug.'),
    name: z.string().describe('UPPER_SNAKE_CASE name, e.g. STRIPE_API_KEY.'),
    value: z.string().describe('The secret value.'),
  }),
  output: z.object({ name: z.string(), updated_at: z.string(), next_step: z.string() }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    if (!SECRET_NAME.test(input.name) || RESERVED_NAMES.has(input.name)) throw new PlatformError('SECRET_NAME_INVALID');
    const bytes = new TextEncoder().encode(input.value).byteLength;
    if (bytes === 0 || bytes > MAX_SECRET_BYTES) {
      throw new PlatformError('INVALID_INPUT', {
        details: { issues: [{ path: ['value'], message: `Must be 1–${MAX_SECRET_BYTES} bytes.` }] },
      });
    }
    if ((await liveVarNames(ctx, app)).includes(input.name)) {
      throw new PlatformError('SECRET_NAME_INVALID', { message: `${input.name} is already used in the app's vars.` });
    }
    const others = await ctx.db
      .select({ n: count() })
      .from(appSecrets)
      .where(and(eq(appSecrets.appId, app.id), ne(appSecrets.name, input.name)))
      .get();
    if ((others?.n ?? 0) + 1 > MAX_SECRETS_PER_APP) {
      throw new PlatformError('QUOTA_EXCEEDED', { details: { limit: 'secrets', max: MAX_SECRETS_PER_APP } });
    }

    await ctx.cloudflare.putSecret(app.scriptName, input.name, input.value);
    const now = ctx.clock.now();
    await ctx.db
      .insert(appSecrets)
      .values({ appId: app.id, name: input.name, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [appSecrets.appId, appSecrets.name], set: { updatedAt: now } });
    return { name: input.name, updated_at: iso(now), next_step: `Read it in code as env.${input.name}.` };
  },
});

export const listSecrets = defineTool({
  name: 'list_secrets',
  description: "Lists the names of the app's secrets (never their values).",
  public: false,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ app: z.string().describe('The app slug.') }),
  output: z.object({ secrets: z.array(z.object({ name: z.string(), updated_at: z.string() })) }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const rows = await ctx.db
      .select()
      .from(appSecrets)
      .where(eq(appSecrets.appId, app.id))
      .orderBy(appSecrets.name)
      .all();
    return { secrets: rows.map((row) => ({ name: row.name, updated_at: iso(row.updatedAt) })) };
  },
});

export const deleteSecret = defineTool({
  name: 'delete_secret',
  description: "Deletes one of the app's secrets. Confirm with the user first; code that reads it will get undefined.",
  public: false,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({ app: z.string().describe('The app slug.'), name: z.string().describe('The secret name.') }),
  output: z.object({ name: z.string(), deleted: z.boolean() }),
  handler: async (input, ctx) => {
    const app = await resolveApp(ctx, input.app, { requireReady: true });
    const removed = await ctx.cloudflare.deleteSecret(app.scriptName, input.name);
    const rows = await ctx.db
      .delete(appSecrets)
      .where(and(eq(appSecrets.appId, app.id), eq(appSecrets.name, input.name)))
      .returning({ name: appSecrets.name })
      .all();
    return { name: input.name, deleted: removed === 'deleted' || rows.length > 0 };
  },
});
