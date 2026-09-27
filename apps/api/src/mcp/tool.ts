import type { AppLogsRpc, Clock, EmailJob, Logger, OrgId, PlatformMailRpc, Random, UserId } from '@repo/shared';
import type { z } from 'zod';
import type { SessionStore } from '../auth/session-store';
import type { ArtifactStore, DeployParams } from '../builds/deploy';
import type { Db } from '../db/client';
import type { CloudflareClient } from '../integrations/cloudflare';
import type { GitHubClient } from '../integrations/github';
import type { RouteStore } from '../runtime/routes';

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type JobQueue<T> = { send(message: T): Promise<unknown> };

/** Starts the ProvisionApp workflow for an app (spec 03). */
export type Provisioner = { start(appId: string): Promise<void> };

/** Everything a tool handler may use. `userId`/`orgId` are set by the auth guard (spec 02). */
export type ToolContext = {
  env: Env;
  sessionId: string;
  logger: Logger;
  clock: Clock;
  random: Random;
  rateLimiter: RateLimiter;
  db: Db;
  session: SessionStore;
  mailer: PlatformMailRpc;
  emailJobs: JobQueue<EmailJob>;
  cloudflare: CloudflareClient;
  github: GitHubClient;
  routes: RouteStore;
  provisioner: Provisioner;
  artifacts: ArtifactStore;
  /** Starts the DeployApp workflow (spec 08). */
  deployer: { start(params: DeployParams): Promise<void> };
  /** The AppLogBuffer Durable Object of an app (spec 10), hosted by the tail worker. */
  appLogs(appId: string): AppLogsRpc;
  /** Waits between polls (real timers in production, instant in tests). */
  sleep(ms: number): Promise<void>;
  userId?: UserId;
  orgId?: OrgId;
};

export type ToolDefinition<I extends z.ZodObject, O extends z.ZodObject> = {
  name: string;
  description: string;
  /** Allowed without login (AUTH-3.3). */
  public: boolean;
  annotations: ToolAnnotations;
  input: I;
  output: O;
  handler: (input: z.output<I>, ctx: ToolContext) => Promise<z.input<O>>;
};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry of tools
export type AnyTool = ToolDefinition<any, any>;

export const defineTool = <I extends z.ZodObject, O extends z.ZodObject>(tool: ToolDefinition<I, O>) => tool;
