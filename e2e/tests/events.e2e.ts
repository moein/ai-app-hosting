import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { signIn } from '../src/auth';
import { analyticsSql, r2Sql } from '../src/cloudflare';
import { flow, slowIt } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { runId, testEmail } from '../src/run';

let client: Client;

const until = async <T>(check: () => Promise<T | undefined>, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
};

describe('event tracking', () => {
  beforeAll(async () => {
    client = await connect((await signIn(testEmail('events'))).accessToken);
  });
  afterAll(async () => {
    await client.close();
  });

  slowIt(
    flow('F-EVT-1', 'a tool call lands in the R2 mcp_events table and in Analytics Engine'),
    async () => {
      const slug = `e2e-evt-${runId}`;
      expect((await callTool(client, 'check_slug', { slug })).ok).toBe(true);
      const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId ?? '';
      const sessionHash = createHash('sha256').update(sessionId).digest('hex');

      type Row = { type: string; tool: string | null; client_name: string | null; args_json: string | null };
      const rows = await until(async () => {
        const found = await r2Sql<Row>(
          `SELECT type, tool, client_name, args_json FROM platform.mcp_events WHERE session_hash = '${sessionHash}'`,
        );
        return found.some((r) => r.tool === 'check_slug') ? found : undefined;
      }, 15 * 60_000);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'mcp_session_initialized', client_name: 'e2e-harness' }),
          expect.objectContaining({ type: 'mcp_tool_call', tool: 'check_slug', args_json: JSON.stringify({ slug }) }),
        ]),
      );
      expect(JSON.stringify(rows)).not.toContain(sessionId);

      const points = await analyticsSql<{ calls: number }>(
        `SELECT SUM(_sample_interval * double1) AS calls FROM platform_metrics_dev
       WHERE blob1 = 'tool_call' AND blob2 = 'check_slug' AND blob5 = 'e2e-harness' AND timestamp > NOW() - INTERVAL '1' HOUR`,
      );
      expect(Number(points[0]?.calls ?? 0)).toBeGreaterThan(0);
    },
    20 * 60_000,
  );
});
