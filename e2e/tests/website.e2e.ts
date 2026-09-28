import { describe, expect, it } from 'vitest';
import { e2eEnv } from '../src/env';
import { flow } from '../src/flows';

describe('homepage', () => {
  it(
    flow('F-WEB-1', 'the homepage on the apex serves the app, its config and screenshots with security headers'),
    async () => {
      const origin = `https://${e2eEnv().E2E_APPS_DOMAIN}`;
      const page = await fetch(`${origin}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<div id="root">');
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('strict-transport-security')).toContain('max-age=');

      const config = (await (await fetch(`${origin}/api/config`)).json()) as { mcpUrl: string; connectorName: string };
      expect(config.mcpUrl).toBe(`${e2eEnv().E2E_API_ORIGIN}/mcp`);
      expect(config.connectorName).toBeTruthy();

      // The bundle referenced by the page and the Claude screenshots are served.
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script, 'bundle referenced from index.html').toBeTruthy();
      expect((await fetch(`${origin}${script}`)).status).toBe(200);
      for (const image of ['/claude/1-settings.png', '/claude/2-connectors.png']) {
        const response = await fetch(`${origin}${image}`);
        expect(response.status, image).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
      }
      // Deep links fall back to the app (single-page application).
      expect((await fetch(`${origin}/anything/else`)).status).toBe(200);
    },
  );
});
