import { env } from 'cloudflare:workers';
import {
  cryptoRandom,
  type EmailJob,
  Logger,
  newId,
  type OrgId,
  type SendLoginCodeInput,
  type SendLoginCodeResult,
  type UserId,
} from '@repo/shared';
import { z } from 'zod';
import { runProvisioning } from '../../src/apps/provision';
import { createSessionStore, memoryStorage } from '../../src/auth/session-store';
import { runDeployment } from '../../src/builds/deploy';
import { createDb } from '../../src/db/client';
import { memberships, organizations, users } from '../../src/db/schema';
import { defineTool, type ToolContext } from '../../src/mcp/tool';
import { fakeCloudflare } from '../fakes/cloudflare';
import { fakeGitHub } from '../fakes/github';

export const fakeClock = (start = Date.UTC(2026, 8, 26)) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) };
};

export type FakeMailer = ToolContext['mailer'] & { sent: SendLoginCodeInput[]; fail: SendLoginCodeResult | null };

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
  mailer: FakeMailer;
  emailJobs: ReturnType<typeof fakeQueue>;
  fakes: { cloudflare: ReturnType<typeof fakeCloudflare>; github: ReturnType<typeof fakeGitHub> };
};

export const testContext = (overrides: Partial<ToolContext> = {}): TestContext => {
  const cloudflare = fakeCloudflare({ d1: env.DB });
  const github = fakeGitHub();
  const ctx = {
    env: env as Env,
    sessionId: 'session-1',
    logger: new Logger({ test: true }),
    clock: fakeClock(),
    random: cryptoRandom,
    rateLimiter: { limit: async () => ({ success: true }) },
    db: createDb(env.DB),
    session: createSessionStore(memoryStorage()),
    mailer: fakeMailer(),
    emailJobs: fakeQueue(),
    cloudflare: cloudflare.client,
    github: github.client,
    routes: env.APP_ROUTES,
    sleep: async () => {},
    artifacts: env.ARTIFACTS,
    fakes: { cloudflare, github },
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
          apiOrigin: ctx.env.PLATFORM_API_ORIGIN,
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
          environment: 'dev',
        },
        params,
      );
    },
  };
  return ctx;
};

/** Creates a user with a personal org and binds it to the context's session. */
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
  await ctx.session.setAuth({ userId, orgId, authenticatedAt: now, lastSeenAt: now });
  // What the auth guard sets for protected tools, for tests that call services directly.
  ctx.userId = userId;
  ctx.orgId = orgId;
  return { userId, orgId };
}

export const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes a message.',
  public: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ message: z.string().min(1), times: z.number().int().min(1).default(1) }),
  output: z.object({ echoed: z.string() }),
  handler: async ({ message, times }) => ({ echoed: message.repeat(times) }),
});

export const privateEcho = defineTool({ ...echoTool, name: 'private_echo', public: false });
