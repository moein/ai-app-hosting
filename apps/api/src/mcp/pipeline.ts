import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PlatformError, TOOL_RESULT_MAX_BYTES, toPlatformError } from '@repo/shared';
import type { z } from 'zod';
import { authGuard } from '../auth/guard';
import { trackToolCall } from '../tracking/track';
import type { AnyTool, ToolContext } from './tool';

export type ToolCall = { tool: AnyTool; args: unknown; ctx: ToolContext; input?: unknown };
export type ToolOutcome = { ok: true; output: Record<string, unknown> } | { ok: false; error: PlatformError };
export type ToolMiddleware = (call: ToolCall, next: () => Promise<ToolOutcome>) => Promise<ToolOutcome>;

/** Per-user limit (MCP-3.8); anonymous calls (public tools) aren't limited here. */
export const rateLimit: ToolMiddleware = async (call, next) => {
  const { userId, rateLimiter } = call.ctx;
  if (userId !== undefined && !(await rateLimiter.limit({ key: userId })).success) {
    throw new PlatformError('RATE_LIMITED', { details: { retry_after_seconds: 60 } });
  }
  return next();
};

export const validateInput: ToolMiddleware = async (call, next) => {
  const parsed = (call.tool.input as z.ZodType).safeParse(call.args ?? {});
  if (!parsed.success) {
    throw new PlatformError('INVALID_INPUT', {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    });
  }
  call.input = parsed.data;
  return next();
};

/** Runs the handler and validates its output (MCP-3.9). Always the last middleware. */
export const runHandler: ToolMiddleware = async (call) => {
  const output = await call.tool.handler(call.input, call.ctx);
  const checked = (call.tool.output as z.ZodType<Record<string, unknown>>).safeParse(output);
  if (!checked.success) {
    call.ctx.logger.error('tool output failed its schema', { tool: call.tool.name, issues: checked.error.issues });
    throw new PlatformError('INTERNAL');
  }
  return { ok: true, output: checked.data };
};

/** Order is part of the contract (MCP-3.7); tracking wraps the whole chain in `runTool`. */
export const MIDDLEWARE: ToolMiddleware[] = [authGuard, rateLimit, validateInput, runHandler];

async function execute(call: ToolCall, middleware: ToolMiddleware[]): Promise<ToolOutcome> {
  const dispatch = async (index: number): Promise<ToolOutcome> => {
    const current = middleware[index];
    if (!current) throw new Error('tool middleware chain ended without a result');
    try {
      return await current(call, () => dispatch(index + 1));
    } catch (error) {
      return { ok: false, error: toPlatformError(error) };
    }
  };
  return dispatch(0);
}

/** Size of the JSON a result carries (its structured content, or the error text). */
const resultBytes = (result: CallToolResult) =>
  new TextEncoder().encode(
    JSON.stringify(result.structuredContent ?? (result.content[0] as { text?: string } | undefined)?.text ?? ''),
  ).byteLength;

function serialize(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    return { structuredContent: outcome.output, content: [{ type: 'text', text: JSON.stringify(outcome.output) }] };
  }
  const error = outcome.error.toJSON();
  // No structuredContent on errors (MCP-3.3): SDK clients validate it against the tool's outputSchema.
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
}

/** One tool call through the full chain, serialized for MCP with the size cap (MCP-3.3, MCP-3.6). */
export async function runTool(
  tool: AnyTool,
  args: unknown,
  ctx: ToolContext,
  middleware: ToolMiddleware[] = MIDDLEWARE,
): Promise<CallToolResult> {
  const started = ctx.clock.now();
  ctx.app = undefined;
  let outcome = await execute({ tool, args, ctx }, middleware);
  if (!outcome.ok && outcome.error.code === 'INTERNAL') {
    ctx.logger.error('tool failed', { tool: tool.name, error: outcome.error.cause ?? outcome.error });
  }
  let result = serialize(outcome);
  const bytes = resultBytes(result);
  if (bytes > TOOL_RESULT_MAX_BYTES) {
    ctx.logger.error('tool result over size cap', { tool: tool.name, bytes });
    outcome = { ok: false, error: new PlatformError('INTERNAL') };
    result = serialize(outcome);
  }
  trackToolCall(ctx, {
    tool: tool.name,
    args,
    outcome,
    durationMs: ctx.clock.now() - started,
    resultBytes: bytes > TOOL_RESULT_MAX_BYTES ? resultBytes(result) : bytes,
  });
  return result;
}
