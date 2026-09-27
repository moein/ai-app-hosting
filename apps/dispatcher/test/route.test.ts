import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppRoute, type RouterDeps, routeRequest } from '../src/route';

const routes: Record<string, AppRoute> = {
  todo: { appId: 'app_1', scriptName: 'todo', state: 'live' },
  wip: { appId: 'app_2', scriptName: 'wip', state: 'not_deployed' },
  broken: { appId: 'app_3', scriptName: 'broken', state: 'live' },
};

const dispatched: { scriptName: string; cpuMs: number; subRequests: number }[] = [];
const deps = (overrides: Partial<RouterDeps> = {}): RouterDeps => ({
  appsDomain: 'motad.app',
  platformWebsiteUrl: '',
  getRoute: async (slug) => routes[slug] ?? null,
  dispatch: (scriptName, limits) => {
    dispatched.push({ scriptName, ...limits });
    if (scriptName === 'broken') throw new Error('script not found');
    return {
      fetch: async (req: Request) => new Response(`hello from ${scriptName} ${new URL(req.url).pathname}`),
    } as Fetcher;
  },
  ...overrides,
});

const get = (url: string, overrides?: Partial<RouterDeps>) => routeRequest(new Request(url), deps(overrides));

describe('dispatcher routing (RUN-1)', () => {
  afterEach(() => {
    dispatched.length = 0;
    vi.restoreAllMocks();
  });

  it('dispatches live apps with the platform CPU/subrequest limits and adds HSTS (RUN-1.4, RUN-1.8)', async () => {
    const res = await get('https://todo.motad.app/api/items');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from todo /api/items');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(dispatched).toEqual([{ scriptName: 'todo', cpuMs: 100, subRequests: 50 }]);
  });

  it('is case-insensitive on the host', async () => {
    expect((await get('https://TODO.Motad.App/')).status).toBe(200);
  });

  it('serves the 503 "being built" page for apps without a live deployment (RUN-1.5)', async () => {
    const res = await get('https://wip.motad.app/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('being built');
  });

  it.each(['https://nope.motad.app/', 'https://a.b.motad.app/', 'https://other.example/'])(
    'serves the 404 page for %s (RUN-1.2, RUN-1.6)',
    async (url) => {
      const res = await get(url);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("There's no app at this address");
    },
  );

  it('apex and www get the 404 page, or redirect when PLATFORM_WEBSITE_URL is set (RUN-1.2)', async () => {
    expect((await get('https://motad.app/')).status).toBe(404);
    expect((await get('https://www.motad.app/')).status).toBe(404);
    const res = await get('https://motad.app/', { platformWebsiteUrl: 'https://example.com/' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/');
  });

  it('returns the 502 page and logs the app when dispatch fails (RUN-1.7)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('https://broken.motad.app/');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('ran into a problem');
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ message: 'dispatch failed', appId: 'app_3' });
  });

  it('redirects http to https (RUN-1.8)', async () => {
    const res = await get('http://todo.motad.app/path?q=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://todo.motad.app/path?q=1');
  });
});
