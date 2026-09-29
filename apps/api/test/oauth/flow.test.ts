import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client';
import { emailSuppressions, memberships, organizations, users } from '../../src/db/schema';
import {
  buildTestProvider,
  echoApiHandler,
  exchangeToken,
  extractError,
  extractPendingId,
  fetchProvider,
  getAuthorize,
  pkcePair,
  postAuthorizeForm,
  registerClient,
  signInThroughOAuth,
  TEST_ORIGIN,
} from './helpers';

let seq = 0;
const freshEmail = () => `oauth${++seq}-${Date.now()}@example.com`;

describe('OAuth metadata (AUTH-4.1, AUTH-4.2)', () => {
  it('serves RFC 9728 protected-resource metadata', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const res = await fetchProvider(provider, `${TEST_ORIGIN}/.well-known/oauth-protected-resource/api`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${TEST_ORIGIN}/api`);
    expect(body.authorization_servers).toEqual([TEST_ORIGIN]);
  });

  it('serves RFC 8414 authorization-server metadata', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const res = await fetchProvider(provider, `${TEST_ORIGIN}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(body.authorization_endpoint).toBe(`${TEST_ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${TEST_ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${TEST_ORIGIN}/oauth/register`);
  });
});

describe('dynamic client registration (AUTH-4.3)', () => {
  it('registers a client and returns a client_id', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, {
      redirectUri: 'https://client.test/callback',
      clientName: 'Claude',
    });
    expect(client.client_id.length).toBeGreaterThan(0);
  });
});

describe('the sign-in page (AUTH-1, AUTH-4.4)', () => {
  it('shows the client name and redirect host, with CSP and no-store headers', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, {
      redirectUri: 'https://client.test/callback',
      clientName: 'Claude',
    });
    const { challenge } = await pkcePair();
    const res = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    // No script-src is allowed at all, so no script can ever run on this page; no form-action is needed as
    // a result (some browsers' CSP matching for it is unreliable even when it names the exact origin).
    expect(csp).not.toContain('form-action');
    const html = await res.text();
    expect(html).toContain('Claude');
    expect(html).toContain('client.test');
  });

  it('rejects a form post from a foreign Origin with 403', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('falls back to a matching Referer when Origin is missing (some browsers omit it)', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { origin: null, referer: `${TEST_ORIGIN}/authorize` },
    );
    expect(res.status).toBe(200);
  });

  it('rejects a post with neither Origin nor Referer, and a foreign Referer', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const neither = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { origin: null },
    );
    expect(neither.status).toBe(403);
    const foreignReferer = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { origin: null, referer: 'https://evil.example/authorize' },
    );
    expect(foreignReferer.status).toBe(403);
  });

  it('accepts Sec-Fetch-Site: same-origin even with the opaque literal Origin: null and no Referer', async () => {
    // A real browser seen in the wild: Origin is the literal string "null" (not absent) and Referer is
    // missing entirely, but Sec-Fetch-Site correctly reports same-origin.
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { origin: 'null', secFetchSite: 'same-origin' },
    );
    expect(res.status).toBe(200);
  });

  it('rejects Sec-Fetch-Site: cross-site even when Origin matches', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(
      provider,
      '/authorize/email',
      { pending: pendingId, email: freshEmail() },
      { secFetchSite: 'cross-site' },
    );
    expect(res.status).toBe(403);
  });

  it('shows an error page for an unknown or expired pending id', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const res = await postAuthorizeForm(provider, '/authorize/email', {
      pending: 'does-not-exist',
      email: freshEmail(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
  });

  it('rejects an invalid email address', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(extractError(await res.text())).toMatch(/valid email/i);
  });

  it('refuses a globally suppressed email without sending', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    await createDb(env.DB).insert(emailSuppressions).values({ email, reason: 'bounce', createdAt: 0 });
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    expect(res.status).toBe(400);
    expect(extractError(await res.text())).toMatch(/can't deliver/i);
    expect(mailer.sent).toHaveLength(0);
  });

  it('shows a message when sending the email fails', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    mailer.fail = { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'down', hint: 'retry', retryable: true } };
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    const res = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email: freshEmail() });
    expect(res.status).toBe(400);
    expect(extractError(await res.text())).toMatch(/couldn't send/i);
  });

  it('limits how many codes one sign-in can request (AUTH-1.6)', async () => {
    const { provider } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    for (let i = 0; i < 3; i++) {
      const res = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
      expect(res.status).toBe(200);
    }
    const fourth = await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    expect(fourth.status).toBe(429);
    expect(extractError(await fourth.text())).toMatch(/too many codes/i);
  });

  it('limits form posts per IP (AUTH-4.8)', async () => {
    const { provider, limiter } = buildTestProvider(echoApiHandler);
    limiter.allow = false;
    const res = await postAuthorizeForm(provider, '/authorize/email', { pending: 'anything', email: freshEmail() });
    expect(res.status).toBe(429);
    expect(limiter.calls.length).toBeGreaterThan(0);
  });

  it('shows attempts left for a wrong code, then requires a new code after 5 wrong tries (AUTH-2.3, AUTH-2.7)', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    const realCode = mailer.sent.at(-1)?.code ?? '';
    const wrong = realCode === '000000' ? '111111' : '000000';

    for (let remaining = 4; remaining >= 1; remaining--) {
      const res = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code: wrong });
      expect(res.status).toBe(400);
      expect(extractError(await res.text())).toContain(`${remaining} ${remaining === 1 ? 'try' : 'tries'} left`);
    }
    const exhausted = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code: wrong });
    expect(exhausted.status).toBe(400);
    expect(extractError(await exhausted.text())).toMatch(/send a new one/i);
    // Even the real code no longer works; a fresh one is required.
    const stillFails = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code: realCode });
    expect(stillFails.status).toBe(400);
  });

  it('redirects with a code and the original state on success (AUTH-2)', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
      state: 'my-state',
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    const code = mailer.sent.at(-1)?.code ?? '';
    const res = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('my-state');
  });

  it('refuses a blocked user', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const db = createDb(env.DB);
    await db.insert(users).values({ id: 'usr_blockedtest01', email, status: 'blocked', createdAt: 0 });
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    const code = mailer.sent.at(-1)?.code ?? '';
    const res = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('blocked');
  });

  it('signs a new email up: user, org, membership and tenant job', async () => {
    const { provider, mailer, emailJobs } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    const code = mailer.sent.at(-1)?.code ?? '';
    await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code });
    const db = createDb(env.DB);
    const user = await db.select().from(users).where(eq(users.email, email)).get();
    expect(user).toBeDefined();
    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user?.id ?? ''))
      .get();
    expect(membership).toBeDefined();
    const org = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, membership?.orgId ?? ''))
      .get();
    expect(org).toBeDefined();
    expect(emailJobs.messages).toEqual([{ type: 'org.provision_email_tenant', orgId: org?.id }]);
  });
});

describe('the token exchange (AUTH-4.5, AUTH-4.6)', () => {
  it('rejects the wrong PKCE verifier', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const client = await registerClient(provider, { redirectUri: 'https://client.test/callback' });
    const { challenge } = await pkcePair();
    const authorizeRes = await getAuthorize(provider, {
      clientId: client.client_id,
      redirectUri: 'https://client.test/callback',
      challenge,
    });
    const pendingId = extractPendingId(await authorizeRes.text());
    await postAuthorizeForm(provider, '/authorize/email', { pending: pendingId, email });
    const loginCode = mailer.sent.at(-1)?.code ?? '';
    const codeRes = await postAuthorizeForm(provider, '/authorize/code', { pending: pendingId, code: loginCode });
    const location = new URL(codeRes.headers.get('location') ?? '');
    const authCode = location.searchParams.get('code') ?? '';
    const res = await exchangeToken(provider, {
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: 'https://client.test/callback',
      client_id: client.client_id,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
    });
    expect(res.status).toBe(400);
  });

  it('gives the API handler {userId, orgId, email} props from the token', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const email = freshEmail();
    const tokens = await signInThroughOAuth(provider, mailer, email);
    const res = await fetchProvider(provider, `${TEST_ORIGIN}/api`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.status).toBe(200);
    const props = (await res.json()) as { userId: string; orgId: string; email: string };
    expect(props.email).toBe(email);
    expect(props.userId).toMatch(/^usr_/);
    expect(props.orgId).toMatch(/^org_/);
  });

  it('rotates the refresh token', async () => {
    const { provider, mailer } = buildTestProvider(echoApiHandler);
    const tokens = await signInThroughOAuth(provider, mailer, freshEmail());
    const res = await exchangeToken(provider, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
    expect(res.ok).toBe(true);
    const refreshed = (await res.json()) as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).not.toBe(tokens.accessToken);
    expect(refreshed.refresh_token).not.toBe(tokens.refreshToken);
  });
});
