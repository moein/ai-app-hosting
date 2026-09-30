import { CONTRACT_VERSION, GUIDE_TOPICS } from '@repo/app-contract';
import { TOOL_RESULT_MAX_BYTES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/pipeline';
import { getPlatformGuide } from '../../src/tools/platform-guide';
import { errorJson, signedInContext } from '../mcp/helpers';

const ctx = () => signedInContext();
type Guide = { contract_version: string; topic: string; markdown: string };

describe('get_platform_guide (MCP-2.2)', () => {
  it('defaults to the whole guide', async () => {
    const result = await runTool(getPlatformGuide, {}, await ctx());
    expect(result.isError).toBeUndefined();
    const guide = result.structuredContent as Guide;
    expect(guide.topic).toBe('all');
    expect(guide.contract_version).toBe(CONTRACT_VERSION);
    expect(guide.markdown).toContain('https://<slug>.motad.app');
    expect(JSON.stringify(guide).length).toBeLessThan(TOOL_RESULT_MAX_BYTES);
  });

  it.each(GUIDE_TOPICS)('returns the %s topic', async (topic) => {
    const guide = (await runTool(getPlatformGuide, { topic }, await ctx())).structuredContent as Guide;
    expect(guide.topic).toBe(topic);
    expect(guide.markdown.length).toBeGreaterThan(200);
  });

  it('rejects unknown topics with INVALID_INPUT', async () => {
    const result = await runTool(getPlatformGuide, { topic: 'recipes' }, await ctx());
    expect(result.isError).toBe(true);
    const error = errorJson(result);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details?.issues?.[0]?.path).toEqual(['topic']);
  });
});
