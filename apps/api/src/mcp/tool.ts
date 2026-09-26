import type { Clock, EmailJob, Logger, OrgId, PlatformMailRpc, Random, UserId } from '@repo/shared';
import type { z } from 'zod';
import type { SessionStore } from '../auth/session-store';
import type { Db } from '../db/client';

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type JobQueue<T> = { send(message: T): Promise<unknown> };

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
