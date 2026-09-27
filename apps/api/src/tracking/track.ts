import { type McpEvent, newId, sha256Hex } from '@repo/shared';
import type { ToolOutcome } from '../mcp/pipeline';
import type { ToolContext } from '../mcp/tool';
import { redactArgs } from './redact';

export type TrackedCall = {
  tool: string;
  args: unknown;
  outcome: ToolOutcome;
  durationMs: number;
  resultBytes: number;
};

/** Sends one event, counting failures instead of throwing (EVT-1.6). */
export async function emitEvent(ctx: Pick<ToolContext, 'events' | 'metrics' | 'logger'>, event: McpEvent) {
  if (!ctx.events) return; // stream not provisioned yet (spec 05 task 1)
  try {
    await ctx.events.send([event]);
  } catch (error) {
    ctx.logger.error('event emit failed', { type: event.type, tool: event.tool, error });
    ctx.metrics.write('event_emit_failed', { orgId: event.org_id, sub: event.type });
  }
}

/**
 * The single tracking point for a finished tool call (EVT-1.1): one `mcp_tool_call` event, one `tool_call`
 * data point, and the feature metrics derived from auth/app tool outcomes. Runs in `waitUntil`; never throws.
 */
export function trackToolCall(ctx: ToolContext, call: TrackedCall): void {
  // Snapshot the mutable context now; the async work runs after the result was returned.
  const snapshot = {
    userId: ctx.userId ?? null,
    orgId: ctx.orgId ?? null,
    app: ctx.app ?? null,
    client: ctx.client,
    now: ctx.clock.now(),
  };
  const task = (async () => {
    const { outcome } = call;
    const errorCode = outcome.ok ? null : outcome.error.code;
    let { userId, orgId } = snapshot;
    if (!userId && outcome.ok && call.tool === 'verify_login_code') {
      const auth = await ctx.session.getAuth();
      userId = auth?.userId ?? null;
      orgId = auth?.orgId ?? null;
    }
    const redacted = await redactArgs(call.tool, call.args);
    const event: McpEvent = {
      event_id: newId('evt'),
      type: 'mcp_tool_call',
      ts: snapshot.now,
      env: ctx.env.ENVIRONMENT as 'dev' | 'prod',
      session_hash: await sha256Hex(ctx.sessionId),
      user_id: userId,
      org_id: orgId,
      app_id: snapshot.app?.id ?? null,
      app_slug: snapshot.app?.slug ?? null,
      client_name: snapshot.client?.name ?? null,
      client_version: snapshot.client?.version ?? null,
      protocol_version: snapshot.client?.protocolVersion ?? null,
      tool: call.tool,
      outcome: outcome.ok ? 'ok' : 'error',
      error_code: errorCode,
      duration_ms: call.durationMs,
      args_json: redacted.argsJson,
      args_truncated: redacted.argsTruncated,
      result_bytes: call.resultBytes,
      email_hash: redacted.emailHash,
    };

    const common = {
      orgId,
      userId,
      appId: event.app_id,
      clientName: event.client_name,
      clientVersion: event.client_version,
    };
    ctx.metrics.write('tool_call', {
      ...common,
      sub: call.tool,
      outcome: event.outcome,
      errorCode,
      durationMs: call.durationMs,
      bytes: call.resultBytes,
    });
    // Feature metrics that are facts of a tool's outcome (spec 05 design, "Feature metrics").
    if (call.tool === 'request_login_code' && outcome.ok) ctx.metrics.write('login_code_requested', common);
    if (call.tool === 'verify_login_code') {
      if (outcome.ok) {
        ctx.metrics.write('login_succeeded', { ...common, sub: outcome.output.is_new_user ? 'signup' : 'signin' });
      } else {
        ctx.metrics.write('login_failed', { ...common, sub: errorCode });
      }
    }
    if (call.tool === 'create_app' && outcome.ok) ctx.metrics.write('app_created', common);
    if (call.tool === 'delete_app' && outcome.ok) ctx.metrics.write('app_deleted', common);

    await emitEvent(ctx, event);
  })().catch((error: unknown) => ctx.logger.error('tool call tracking failed', { tool: call.tool, error }));
  ctx.waitUntil(task);
}
