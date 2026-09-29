import { e2eEnv } from './env';
import { extractLoginCode, waitForEmail } from './inbox';

export type OAuthTokens = { accessToken: string; refreshToken: string; clientId: string; redirectUri: string };

/** Not a real endpoint the harness ever calls back; only the `code=`/`state=` query the sign-in redirects to. */
const REDIRECT_URI = 'https://e2e.invalid/callback';

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

function extractPendingId(html: string): string {
  const match = html.match(/name="pending" value="([^"]+)"/);
  if (!match?.[1]) throw new Error('pending id not found on the sign-in page');
  return match[1];
}

/** The sign-in page's `<p class="error">` text, HTML-entity-decoded. */
export function extractError(html: string): string | null {
  const match = html.match(/class="error"[^>]*>([^<]+)</);
  return match?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, '&') ?? null;
}

/** Dynamic client registration (RFC 7591, AUTH-4.3): one fresh OAuth client per sign-in. */
export async function registerClient(clientName = 'e2e-harness'): Promise<string> {
  const res = await fetch(new URL('/oauth/register', e2eEnv().E2E_API_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: clientName,
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

/** `GET /authorize`; returns the pending sign-in id parsed out of the page. */
export async function getAuthorizePage(clientId: string, challenge: string, state: string): Promise<string> {
  const url = new URL('/authorize', e2eEnv().E2E_API_ORIGIN);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'apps');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /authorize failed: ${res.status} ${await res.text()}`);
  return extractPendingId(await res.text());
}

/** Posts the sign-in form (email or code step) with the Origin header the page's own forms send (AUTH-4.8). */
export async function postAuthorizeForm(path: string, fields: Record<string, string>): Promise<Response> {
  const { E2E_API_ORIGIN } = e2eEnv();
  return fetch(new URL(path, E2E_API_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: E2E_API_ORIGIN },
    redirect: 'manual',
    body: new URLSearchParams(fields).toString(),
  });
}

export async function exchangeToken(
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch(new URL('/oauth/token', e2eEnv().E2E_API_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * The full OAuth sign-in a real MCP client performs (spec 02, AUTH-1/2/4): DCR, PKCE, the sign-in page, the
 * code emailed to the real e2e inbox, and the token exchange. Returns the tokens; `connect(tokens.accessToken)`
 * opens an authenticated MCP session with them.
 */
export async function signIn(email: string): Promise<OAuthTokens> {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkcePair();
  const pendingId = await getAuthorizePage(clientId, challenge, crypto.randomUUID());

  const since = Date.now() - 5_000;
  const emailRes = await postAuthorizeForm('/authorize/email', { pending: pendingId, email });
  if (emailRes.status !== 200)
    throw new Error(`sign-in email step failed: ${emailRes.status} ${await emailRes.text()}`);

  const message = await waitForEmail({
    to: email,
    since,
    timeoutMs: 120_000,
    match: (m) => /login code/i.test(m.subject),
  });
  const code = extractLoginCode(message);

  const codeRes = await postAuthorizeForm('/authorize/code', { pending: pendingId, code });
  if (codeRes.status !== 302) throw new Error(`sign-in code step failed: ${codeRes.status} ${await codeRes.text()}`);
  const location = new URL(codeRes.headers.get('location') ?? '', REDIRECT_URI);
  const authCode = location.searchParams.get('code');
  if (!authCode) throw new Error(`no authorization code in the sign-in redirect: ${location}`);

  const tokens = await exchangeToken({
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId, redirectUri: REDIRECT_URI };
}
