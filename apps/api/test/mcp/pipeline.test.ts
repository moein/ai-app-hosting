import { PlatformError } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MIDDLEWARE, runTool } from '../../src/mcp/pipeline';
import { defineTool } from '../../src/mcp/tool';
import { echoTool, privateEcho, signIn, testContext } from './helpers';

const errorOf = (result: Awaited<ReturnType<typeof runTool>>) =>
  (result.structuredContent as { error: { code: string; hint: string; details?: Record<string, unknown> } }).error;

describe('runTool (MCP-3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns structuredContent and the same JSON as text (MCP-1.3)', async () => {
    const result = await runTool(echoTool, { message: 'hi', times: 2 }, testContext());
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ echoed: 'hihi' });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: 'hihi' }) }]);
  });

  it('invalid input → INVALID_INPUT tool result with issue paths (MCP-3.2, MCP-3.3)', async () => {
    const result = await runTool(echoTool, { message: '', times: 0 }, testContext());
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_INPUT');
    const issues = (error.details?.issues ?? []) as { path: string[] }[];
    expect(issues.map((i) => i.path)).toEqual([['message'], ['times']]);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ error });
  });

  it('a thrown PlatformError becomes an isError result, not a protocol error', async () => {
    const tool = defineTool({
      ...echoTool,
      handler: async () => {
        throw new PlatformError('CONFLICT');
      },
    });
    const error = errorOf(await runTool(tool, { message: 'x' }, testContext()));
    expect(error.code).toBe('CONFLICT');
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('an unexpected exception becomes INTERNAL without leaking details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tool = defineTool({
      ...echoTool,
      handler: async () => {
        throw new Error('secret internals');
      },
    });
    const result = await runTool(tool, { message: 'x' }, testContext());
    expect(errorOf(result).code).toBe('INTERNAL');
    expect(JSON.stringify(result)).not.toContain('secret internals');
  });

  it('output that fails its schema → INTERNAL (MCP-3.9)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tool = defineTool({ ...echoTool, handler: async () => ({ echoed: 42 }) as unknown as { echoed: string } });
    expect(errorOf(await runTool(tool, { message: 'x' }, testContext())).code).toBe('INTERNAL');
  });

  it('results over the 100 KB cap → INTERNAL (MCP-3.6)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tool = defineTool({
      ...echoTool,
      output: z.object({ echoed: z.string() }),
      handler: async () => ({ echoed: 'x'.repeat(100_001) }),
    });
    expect(errorOf(await runTool(tool, { message: 'x' }, testContext())).code).toBe('INTERNAL');
  });

  it('protected tools require a signed-in session', async () => {
    expect(errorOf(await runTool(privateEcho, { message: 'x' }, testContext())).code).toBe('AUTH_REQUIRED');
    const ctx = testContext();
    await signIn(ctx);
    expect((await runTool(privateEcho, { message: 'x' }, ctx)).isError).toBeUndefined();
  });

  it('rate limits authenticated users per user id (MCP-3.8)', async () => {
    const seen: string[] = [];
    let calls = 0;
    const rateLimiter = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        calls += 1;
        return { success: calls <= 120 };
      },
    };
    const ctx = testContext({ rateLimiter });
    const { userId } = await signIn(ctx);
    for (let i = 0; i < 120; i++) await runTool(privateEcho, { message: 'x' }, ctx);
    const error = errorOf(await runTool(privateEcho, { message: 'x' }, ctx));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.details).toEqual({ retry_after_seconds: 60 });
    expect(new Set(seen)).toEqual(new Set([userId]));
  });

  it('runs the chain in the documented order: auth → rate limit → input validation → handler (MCP-3.7)', async () => {
    expect(MIDDLEWARE.map((m) => m.name)).toEqual(['authGuard', 'rateLimit', 'validateInput', 'runHandler']);
    // auth is checked before validation: an anonymous call with bad input is AUTH_REQUIRED, not INVALID_INPUT
    expect(errorOf(await runTool(privateEcho, { message: '' }, testContext())).code).toBe('AUTH_REQUIRED');
    // rate limit is checked before validation
    const denied = testContext({ rateLimiter: { limit: async () => ({ success: false }) } });
    await signIn(denied);
    expect(errorOf(await runTool(privateEcho, { message: '' }, denied)).code).toBe('RATE_LIMITED');
  });

  it('logs one "tool call" line per call with outcome and duration, never arguments', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await runTool(echoTool, { message: 'top-secret-arg' }, testContext());
    expect(info).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(info.mock.lastCall?.[0]));
    expect(entry).toMatchObject({ message: 'tool call', tool: 'echo', outcome: 'ok' });
    expect(JSON.stringify(entry)).not.toContain('top-secret-arg');
  });
});
