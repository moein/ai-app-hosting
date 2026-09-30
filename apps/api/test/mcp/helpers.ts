import { env } from 'cloudflare:workers';
import {
  cryptoRandom,
  type EmailJob,
  Logger,
  type McpEventRecord,
  memoryMetrics,
  newId,
  type OrgId,
  type PlatformMailRpc,
  type SendLoginCodeInput,
  type SendLoginCodeResult,
  type UserId,
} from '@repo/shared';
import { z } from 'zod';
import { runProvisioning } from '../../src/apps/provision';
import { runDeployment } from '../../src/builds/deploy';
import { createDb } from '../../src/db/client';
import { memberships, organizations, users } from '../../src/db/schema';
import { appLogsFor } from '../../src/logs/app-logs';
import { defineTool, type ToolContext } from '../../src/mcp/tool';
import { fakeCloudflare } from '../fakes/cloudflare';
import { fakeGitHub } from '../fakes/github';
import { fakeR2Objects } from '../fakes/r2-objects';

export const fakeClock = (start = Date.UTC(2026, 8, 26)) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) };
};

export type FakeMailer = PlatformMailRpc & { sent: SendLoginCodeInput[]; fail: SendLoginCodeResult | null };

export function fakeMailer(): FakeMailer {
  const mailer: FakeMailer = {
    sent: [],
    fail: null,
    async sendLoginCode(input) {
      if (mailer.fail) return mailer.fail;
      mailer.sent.push(input);
      return { ok: true, id: `msg_${mailer.sent.length}` };
    },
  };
  return mailer;
}

export const fakeQueue = () => {
  const messages: EmailJob[] = [];
  return { messages, send: async (message: EmailJob) => void messages.push(message) };
};

export type TestContext = ToolContext & {
  clock: ReturnType<typeof fakeClock>;
  metrics: ReturnType<typeof memoryMetrics>;
  /** Events sent to the fake EVENTS stream. */
  sentEvents: McpEventRecord[];
  /** Background work handed to waitUntil (tracking); await `flush(ctx)` before asserting on it. */
  pending: Promise<unknown>[];
  emailJobs: ReturnType<typeof fakeQueue>;
  fakes: {
    cloudflare: ReturnType<typeof fakeCloudflare>;
    github: ReturnType<typeof fakeGitHub>;
    r2Objects: ReturnType<typeof fakeR2Objects>;
  };
};

export const testContext = (overrides: Partial<ToolContext> = {}): TestContext => {
  const cloudflare = fakeCloudflare({ d1: env.DB });
  const github = fakeGitHub();
  const r2Objects = fakeR2Objects();
  const sentEvents: McpEventRecord[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    env: env as Env,
    sessionId: 'session-1',
    logger: new Logger({ test: true }),
    clock: fakeClock(),
    random: cryptoRandom,
    rateLimiter: { limit: async () => ({ success: true }) },
    db: createDb(env.DB),
    emailJobs: fakeQueue(),
    cloudflare: cloudflare.client,
    github: github.client,
    r2Objects: r2Objects.client,
    routes: env.APP_ROUTES,
    sleep: async () => {},
    artifacts: env.ARTIFACTS,
    appLogs: (appId: string) => appLogsFor(env as Env, appId),
    fakes: { cloudflare, github, r2Objects },
    metrics: memoryMetrics(),
    client: { name: 'test-client', version: '1.0.0', protocolVersion: '2025-06-18' },
    sentEvents,
    pending,
    events: { send: async (records: McpEventRecord[]) => void sentEvents.push(...records) },
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    ...overrides,
  } as TestContext;
  // Provisioning runs inline against the fakes, as the workflow would.
  ctx.provisioner = overrides.provisioner ?? {
    start: async (appId) => {
      await runProvisioning(
        {
          db: ctx.db,
          cloudflare: ctx.cloudflare,
          github: ctx.github,
          routes: ctx.routes,
          clock: ctx.clock,
          logger: ctx.logger,
          metrics: ctx.metrics,
          emailJobs: ctx.emailJobs,
          apiOrigin: ctx.env.PLATFORM_API_ORIGIN,
          environment: 'dev',
        },
        appId,
      ).catch(() => {});
    },
  };
  // Deployments run inline against the fakes, as the DeployApp workflow would.
  ctx.deployer = overrides.deployer ?? {
    start: async (params) => {
      await runDeployment(
        {
          db: ctx.db,
          cloudflare: ctx.cloudflare,
          routes: ctx.routes,
          artifacts: ctx.artifacts,
          clock: ctx.clock,
          logger: ctx.logger,
          metrics: ctx.metrics,
          environment: 'dev',
        },
        params,
      );
    },
  };
  return ctx;
};

/** The PlatformError JSON of an error result (its text content; error results have no structuredContent). */
export function errorJson(result: { content: unknown }): {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
  details?: Record<string, unknown> & { issues?: { path: string[]; message: string }[] };
} {
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '{}';
  return (JSON.parse(text) as { error: ReturnType<typeof errorJson> }).error;
}

/** Waits for all background work (tracking) handed to waitUntil so far. */
export async function flush(ctx: TestContext): Promise<void> {
  while (ctx.pending.length > 0) await Promise.all(ctx.pending.splice(0));
}

/** Creates a user with a personal org and makes the context act as them (as a token's props would). */
export async function signIn(ctx: ToolContext, options: { email?: string; status?: 'active' | 'blocked' } = {}) {
  const now = ctx.clock.now();
  const userId = newId('usr') as UserId;
  const orgId = newId('org') as OrgId;
  await ctx.db.batch([
    ctx.db.insert(users).values({
      id: userId,
      email: options.email ?? `${userId.toLowerCase()}@test.example`,
      status: options.status ?? 'active',
      createdAt: now,
    }),
    ctx.db.insert(organizations).values({
      id: orgId,
      slug: `org-${userId
        .slice(4)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}`,
      name: 'test',
      createdAt: now,
      updatedAt: now,
    }),
    ctx.db.insert(memberships).values({ orgId, userId, createdAt: now }),
  ]);
  // What the OAuth token's props give every tool call (AUTH-4.7).
  ctx.userId = userId;
  ctx.orgId = orgId;
  ctx.email = options.email ?? `${userId.toLowerCase()}@test.example`;
  return { userId, orgId };
}

/** A context already signed in, for tests that aren't about missing auth (every tool needs a user; AUTH-4.7). */
export async function signedInContext(overrides: Partial<ToolContext> = {}): Promise<TestContext> {
  const ctx = testContext(overrides);
  await signIn(ctx);
  return ctx;
}

export const echoTool = defineTool({
  name: 'echo',
  title: 'Echo',
  description: 'Echoes a message.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ message: z.string().min(1), times: z.number().int().min(1).default(1) }),
  output: z.object({ echoed: z.string() }),
  handler: async ({ message, times }) => ({ echoed: message.repeat(times) }),
});

export const privateEcho = defineTool({ ...echoTool, name: 'private_echo' });
