import { createExecutionContext, env } from 'cloudflare:test';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { cryptoRandom, Logger, memoryMetrics, OAUTH_ACCESS_TOKEN_TTL_S, OAUTH_REFRESH_TOKEN_TTL_S } from '@repo/shared';
import { Hono } from 'hono';
import { createDb } from '../../src/db/client';
import type { AppEnv } from '../../src/http/env';
import { type AuthorizeDeps, createAuthorizeRoutes } from '../../src/http/routes/authorize';
import { type FakeMailer, fakeClock, fakeMailer, fakeQueue } from '../mcp/helpers';

/** Origin the test harness's provider serves from; matches what guardPost checks the form's Origin against. */
export const TEST_ORIGIN = 'https://api.test';

/** An API handler as OAuthProvider expects it: a fetch handler whose ctx carries the grant's props. */
export type TestApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }): Response | Promise<Response>;
};

export type TestLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
  calls: string[];
  allow: boolean;
};

const testLimiter = (): TestLimiter => {
  const calls: string[] = [];
  const limiter: TestLimiter = {
    calls,
    allow: true,
    limit: async ({ key }) => {
      calls.push(key);
      return { success: limiter.allow };
    },
  };
  return limiter;
};

/**
 * A local OAuthProvider wired exactly like production's `providerFor` (spec 02, AUTH-4), but with a fake
 * mailer and limiter so tests can capture login codes and control rate limiting directly.
 */
export function buildTestProvider(apiHandler: TestApiHandler) {
  const mailer = fakeMailer();
  const emailJobs = fakeQueue();
  const clock = fakeClock();
  const limiter = testLimiter();
  const depsFor = (e: Env): AuthorizeDeps => ({
    login: { db: createDb(e.DB), random: cryptoRandom, pepper: e.LOGIN_CODE_PEPPER, mailer, emailJobs },
    oauth: e.OAUTH_PROVIDER,
    kv: e.OAUTH_KV,
    limiter,
    origin: TEST_ORIGIN,
    clock,
    metrics: memoryMetrics(),
    logger: Logger.root.child({ test: true }),
  });
  const defaultApp = new Hono<AppEnv>().route('/authorize', createAuthorizeRoutes(depsFor));
  const provider = new OAuthProvider<Env>({
    apiRoute: '/api',
    apiHandler,
    defaultHandler: { fetch: (request, e, ctx) => defaultApp.fetch(request, e, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['apps'],
    accessTokenTTL: OAUTH_ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: OAUTH_REFRESH_TOKEN_TTL_S,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${TEST_ORIGIN}/api`,
      authorization_servers: [TEST_ORIGIN],
      scopes_supported: ['apps'],
      bearer_methods_supported: ['header'],
      resource_name: 'AI App Hosting',
    },
  });
  return { provider, mailer, emailJobs, limiter, clock };
}

export function fetchProvider(
  provider: OAuthProvider<Env>,
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return provider.fetch(new Request(input, init), env as Env, createExecutionContext());
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function registerClient(
  provider: OAuthProvider<Env>,
  options: { redirectUri: string; clientName?: string },
): Promise<{ client_id: string; client_secret?: string }> {
  const res = await fetchProvider(provider, `${TEST_ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [options.redirectUri],
      client_name: options.clientName ?? 'Test Client',
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Pulls the hidden `pending` field out of a sign-in page's HTML. */
export function extractPendingId(html: string): string {
  const match = html.match(/name="pending" value="([^"]+)"/);
  if (!match?.[1]) throw new Error(`pending id not found in HTML: ${html.slice(0, 200)}`);
  return match[1];
}

export function extractError(html: string): string | null {
  const match = html.match(/class="error"[^>]*>([^<]+)</);
  return match?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, '&') ?? null;
}

export async function getAuthorize(
  provider: OAuthProvider<Env>,
  options: { clientId: string; redirectUri: string; challenge: string; state?: string },
): Promise<Response> {
  const url = new URL(`${TEST_ORIGIN}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', 'apps');
  url.searchParams.set('state', options.state ?? 'test-state');
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return fetchProvider(provider, url);
}

export async function postAuthorizeForm(
  provider: OAuthProvider<Env>,
  path: string,
  fields: Record<string, string>,
  options: { origin?: string | null; referer?: string | null; secFetchSite?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (options.origin !== null) headers.origin = options.origin ?? TEST_ORIGIN;
  if (options.referer) headers.referer = options.referer;
  if (options.secFetchSite) headers['sec-fetch-site'] = options.secFetchSite;
  return fetchProvider(provider, `${TEST_ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

export async function exchangeToken(provider: OAuthProvider<Env>, params: Record<string, string>): Promise<Response> {
  return fetchProvider(provider, `${TEST_ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

export type SignedIn = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  codeVerifier: string;
  redirectUri: string;
};

/**
 * The full sign-in dance a real MCP client performs (spec 02, AUTH-1/2/4): DCR, PKCE, the authorize page,
 * the emailed code (captured from the fake mailer), and the token exchange. Returns the issued tokens.
 */
export async function signInThroughOAuth(
  provider: OAuthProvider<Env>,
  mailer: FakeMailer,
  email: string,
  options: { redirectUri?: string } = {},
): Promise<SignedIn> {
  const redirectUri = options.redirectUri ?? 'https://client.test/callback';
  const { client_id: clientId } = await registerClient(provider, { redirectUri });
  const { verifier, challenge } = await pkcePair();
  const authorizeRes = await getAuthorize(provider, { clientId, redirectUri, challenge });
  const pendingId = extractPendingId(await authorizeRes.text());

  const emailRes = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
  if (emailRes.status !== 200) throw new Error(`email step failed: ${emailRes.status} ${await emailRes.text()}`);
  const code = mailer.sent.at(-1)?.code;
  if (!code) throw new Error('no login code was sent');

  const codeRes = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code });
  if (codeRes.status !== 302) throw new Error(`code step failed: ${codeRes.status} ${await codeRes.text()}`);
  const location = new URL(codeRes.headers.get('location') ?? '', redirectUri);
  const authCode = location.searchParams.get('code');
  if (!authCode) throw new Error(`no code in redirect: ${location}`);

  const tokenRes = await exchangeToken(provider, {
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return {
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    codeVerifier: verifier,
    redirectUri,
  };
}

export const echoApiHandler: TestApiHandler = {
  fetch: (_request, _env, ctx) => Response.json(ctx.props ?? null),
};
