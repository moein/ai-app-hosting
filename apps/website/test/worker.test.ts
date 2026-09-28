import { describe, expect, it } from 'vitest';
import worker from '../src/worker';

const env = {
  MCP_URL: 'https://api-dev.example/mcp',
  CONNECTOR_NAME: 'AI App Hosting (dev)',
  ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) },
} as unknown as Env;
const call = (url: string) => worker.fetch(new Request(url), env);

describe('website worker (spec 14 task 1)', () => {
  it('serves the config from vars', async () => {
    const response = await call('https://motad.app/api/config');
    expect(await response.json()).toEqual({
      mcpUrl: 'https://api-dev.example/mcp',
      connectorName: 'AI App Hosting (dev)',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('adds security headers to pages and assets', async () => {
    for (const url of ['https://motad.app/', 'https://motad.app/claude/1-settings.png']) {
      const response = await call(url);
      expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('redirects http to https', async () => {
    const response = await call('http://motad.app/#/connect');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://motad.app/#/connect');
  });
});
