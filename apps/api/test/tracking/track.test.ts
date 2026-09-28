import { PlatformError, sha256Hex } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/pipeline';
import { defineTool } from '../../src/mcp/tool';
import { createApp } from '../../src/tools/apps/create-app';
import { deleteApp } from '../../src/tools/apps/delete-app';
import { getApp } from '../../src/tools/apps/get-app';
import { requestLoginCode } from '../../src/tools/auth/request-login-code';
import { verifyLoginCode } from '../../src/tools/auth/verify-login-code';
import { clientInfoFrom, sessionInitializedEvent } from '../../src/tracking/session-events';
import { echoTool, flush, privateEcho, signIn, type TestContext, testContext } from '../mcp/helpers';

const failing = defineTool({
  ...echoTool,
  name: 'failing',
  handler: async () => {
    throw new PlatformError('CONFLICT');
  },
});
const run = async (ctx: TestContext, ...call: Parameters<typeof runTool>) => {
  const result = await runTool(...call);
  await flush(ctx);
  return result;
};

describe('mcp_tool_call events (EVT-1.1, EVT-1.3, EVT-1.6)', () => {
  it.each([
    ['ok', echoTool, { message: 'hi' }, 'ok', null],
    ['handler error', failing, { message: 'hi' }, 'error', 'CONFLICT'],
    ['AUTH_REQUIRED', privateEcho, { message: 'hi' }, 'error', 'AUTH_REQUIRED'],
    ['INVALID_INPUT', echoTool, { message: '' }, 'error', 'INVALID_INPUT'],
  ] as const)('emits exactly one event for %s', async (_, tool, args, outcome, code) => {
    const ctx = testContext();
    await run(ctx, tool, args, ctx);
    expect(ctx.sentEvents).toHaveLength(1);
    expect(ctx.sentEvents[0]).toMatchObject({ type: 'mcp_tool_call', tool: tool.name, outcome });
    // Null fields are left out of the record (the stream treats missing as null).
    expect(ctx.sentEvents[0]?.error_code).toBe(code ?? undefined);
    expect(ctx.metrics.points.filter((p) => p.event === 'tool_call')).toHaveLength(1);
  });

  it('emits one event for RATE_LIMITED', async () => {
    const ctx = testContext({ rateLimiter: { limit: async () => ({ success: false }) } });
    await signIn(ctx);
    await run(ctx, privateEcho, { message: 'hi' }, ctx);
    expect(ctx.sentEvents.map((e) => e.error_code)).toEqual(['RATE_LIMITED']);
  });

  it('carries env, hashed session, user, org, app and client info — never the raw session id', async () => {
    const ctx = testContext();
    const { userId, orgId } = await signIn(ctx);
    const created = await run(ctx, createApp, { name: 'Tracked App' }, ctx);
    const slug = (created.structuredContent as { slug: string }).slug;
    ctx.sentEvents.length = 0;
    await run(ctx, getApp, { app: slug }, ctx);
    const [event] = ctx.sentEvents;
    expect(event).toMatchObject({
      env: 'dev',
      session_hash: await sha256Hex('session-1'),
      user_id: userId,
      org_id: orgId,
      app_slug: slug,
      client_name: 'test-client',
      client_version: '1.0.0',
      protocol_version: '2025-06-18',
      args_json: JSON.stringify({ app: slug }),
    });
    expect(event?.app_id).toMatch(/^app_/);
    expect(event?.event_id).toMatch(/^evt_/);
    expect(JSON.stringify(ctx.sentEvents)).not.toContain('"session-1"');
    expect(ctx.metrics.points.filter((p) => p.event === 'tool_call').at(-1)?.fields).toMatchObject({
      sub: 'get_app',
      outcome: 'ok',
      orgId,
      clientName: 'test-client',
    });
  });

  it('does not fail the tool when the stream rejects the event, and counts the failure', async () => {
    const ctx = testContext();
    ctx.events = {
      send: async () => {
        throw new Error('pipeline down');
      },
    };
    const result = await run(ctx, echoTool, { message: 'hi' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(ctx.metrics.points.map((p) => p.event)).toContain('event_emit_failed');
  });

  it('skips events while the EVENTS stream is not bound', async () => {
    const ctx = testContext({ events: undefined });
    const result = await run(ctx, echoTool, { message: 'hi' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(ctx.metrics.points.map((p) => p.event)).toEqual(['tool_call']);
  });
});

describe('feature metrics from tool outcomes (EVT-2.2, EVT-2.3)', () => {
  it('login: code requested, signup, signin and failures', async () => {
    const ctx = testContext();
    const email = `metrics-${Date.now()}@example.com`;
    await run(ctx, requestLoginCode, { email }, ctx);
    await run(
      ctx,
      verifyLoginCode,
      { email, code: '000000' === ctx.mailer.sent.at(-1)?.code ? '111111' : '000000' },
      ctx,
    );
    await run(ctx, verifyLoginCode, { email, code: ctx.mailer.sent.at(-1)?.code ?? '' }, ctx);
    const again = testContext();
    await run(again, requestLoginCode, { email }, again);
    await run(again, verifyLoginCode, { email, code: again.mailer.sent.at(-1)?.code ?? '' }, again);

    const points = [...ctx.metrics.points, ...again.metrics.points].filter((p) => p.event !== 'tool_call');
    expect(points.map((p) => [p.event, p.fields.sub ?? null])).toEqual([
      ['login_code_requested', null],
      ['login_failed', 'CODE_INVALID'],
      ['login_succeeded', 'signup'],
      ['login_code_requested', null],
      ['login_succeeded', 'signin'],
    ]);
    // After verify the event carries the new identity, and the email only as a hash.
    const verified = ctx.sentEvents.at(-1);
    expect(verified?.user_id).toMatch(/^usr_/);
    expect(verified?.email_hash).toBe(await sha256Hex(email));
    expect(JSON.stringify(ctx.sentEvents)).not.toContain(email);
  });

  it('apps: created and deleted', async () => {
    const ctx = testContext();
    await signIn(ctx);
    const created = await run(ctx, createApp, { name: 'Metric App' }, ctx);
    const slug = (created.structuredContent as { slug: string }).slug;
    await run(ctx, deleteApp, { app: slug, confirm_slug: slug }, ctx);
    expect(ctx.metrics.points.map((p) => p.event).filter((e) => e.startsWith('app_'))).toEqual([
      'app_created',
      'app_deleted',
    ]);
  });
});

describe('session initialized (EVT-1.2)', () => {
  it('reads client info from the initialize request and builds the event', async () => {
    const client = clientInfoFrom({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '0.1.0' }, capabilities: {} },
    });
    expect(client).toEqual({ name: 'claude-ai', version: '0.1.0', protocolVersion: '2025-06-18' });
    expect(clientInfoFrom(undefined)).toBeNull();
    const event = await sessionInitializedEvent({ sessionId: 'raw-session', env: 'dev', now: 1, client });
    expect(event).toMatchObject({
      type: 'mcp_session_initialized',
      session_hash: await sha256Hex('raw-session'),
      client_name: 'claude-ai',
      client_version: '0.1.0',
      protocol_version: '2025-06-18',
      tool: null,
      outcome: null,
    });
    expect(JSON.stringify(event)).not.toContain('raw-session');
  });
});
