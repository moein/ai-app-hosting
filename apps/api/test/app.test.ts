import { SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describe, expect, it } from 'vitest';
import { app, ROUTE_PREFIXES } from '../src/http/app';
import { healthRoutes } from '../src/http/routes/health';

describe('route groups (FND-8)', () => {
  it('healthRoutes works in isolation, without the main app', async () => {
    const res = await healthRoutes.request(
      '/',
      {},
      {
        ENVIRONMENT: 'dev',
        CF_ACCOUNT_ID: 'x',
        PLATFORM_API_ORIGIN: 'https://api.example.com',
        APPS_DOMAIN: 'example.com',
        GITHUB_ORG: 'org',
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', environment: 'dev' });
  });

  it('main app only mounts groups: every route is global middleware or under a mounted prefix', () => {
    for (const route of app.routes) {
      const global = route.path === '*' || route.path === '/*';
      const mounted = ROUTE_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
      expect(global || mounted, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('group-scoped middleware runs only for its own group', async () => {
    const seen: string[] = [];
    const tag = createMiddleware(async (c, next) => {
      seen.push(c.req.path);
      await next();
    });
    const guarded = new Hono().use('*', tag).get('/', (c) => c.text('guarded'));
    const open = new Hono().get('/', (c) => c.text('open'));
    const main = new Hono().route('/guarded', guarded).route('/open', open);
    await main.request('/open');
    await main.request('/guarded');
    expect(seen).toEqual(['/guarded']);
  });
});

describe('api worker (deployed shape)', () => {
  it('GET /healthz reports the environment and a request id', async () => {
    const res = await SELF.fetch('https://api.test/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'api', environment: 'dev' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('unknown routes return a NOT_FOUND PlatformError', async () => {
    const res = await SELF.fetch('https://api.test/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.hint.length).toBeGreaterThan(0);
  });
});
