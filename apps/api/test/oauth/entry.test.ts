import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const url = (path: string) => `${env.PLATFORM_API_ORIGIN}${path}`;

/** The real production entry (spec 02, AUTH-4): /mcp is gated by OAuthProvider; everything else reaches Hono. */
describe('api entry point with the OAuth provider in front (AUTH-4.1, AUTH-4.2)', () => {
  it('rejects /mcp without a token, with a WWW-Authenticate pointing at the resource metadata', async () => {
    const res = await SELF.fetch(url('/mcp'));
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('resource_metadata');
  });

  it('rejects /mcp with a bad token the same way', async () => {
    const res = await SELF.fetch(url('/mcp'), { headers: { authorization: 'Bearer not-a-real-token' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('resource_metadata');
  });

  it('serves the RFC 9728 protected-resource metadata', async () => {
    const res = await SELF.fetch(url('/.well-known/oauth-protected-resource/mcp'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${env.PLATFORM_API_ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([env.PLATFORM_API_ORIGIN]);
  });

  it('serves the RFC 8414 authorization-server metadata', async () => {
    const res = await SELF.fetch(url('/.well-known/oauth-authorization-server'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_endpoint: string; token_endpoint: string };
    expect(body.authorization_endpoint).toBe(`${env.PLATFORM_API_ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${env.PLATFORM_API_ORIGIN}/oauth/token`);
  });

  it('still reaches Hono for non-API routes: /healthz, /v1/contract, /v1/builds', async () => {
    const notGatedByOAuth = (res: Response) => expect(res.headers.get('www-authenticate')).toBeNull();

    const health = await SELF.fetch(url('/healthz'));
    expect(health.status).toBe(200);
    notGatedByOAuth(health);

    const contract = await SELF.fetch(url('/v1/contract'));
    notGatedByOAuth(contract);

    // No OIDC token: Hono's own build-callback auth rejects it, not the OAuth provider's gate.
    const builds = await SELF.fetch(url('/v1/builds/does-not-exist'), { method: 'POST' });
    expect(builds.status).toBe(401);
    notGatedByOAuth(builds);
  });
});
