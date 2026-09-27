import type { GitHubOidcClaims } from '../../src/builds/oidc';

let keys: { privateKey: CryptoKey; jwk: JsonWebKey; fetch: typeof fetch } | undefined;

const b64url = (data: string | Uint8Array) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A test RSA key pair and a fetch that serves its JWKS like GitHub. */
export async function oidcKeys() {
  if (keys) return keys;
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = {
    ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey),
    kid: 'test-kid',
    alg: 'RS256',
    use: 'sig',
  };
  const fetchJwks = (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch;
  keys = { privateKey: pair.privateKey, jwk, fetch: fetchJwks };
  return keys;
}

export const validClaims = (now: number, overrides: Partial<GitHubOidcClaims> = {}): GitHubOidcClaims => ({
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'https://api.test',
  exp: Math.floor(now / 1000) + 300,
  iat: Math.floor(now / 1000),
  repository: 'AI-app-hosting/dev-todo',
  repository_id: '42',
  repository_owner: 'AI-app-hosting',
  ref: 'refs/heads/main',
  workflow_ref: 'AI-app-hosting/dev-todo/.github/workflows/deploy.yml@refs/heads/main',
  event_name: 'push',
  ...overrides,
});

export async function signOidc(claims: GitHubOidcClaims, kid = 'test-kid'): Promise<string> {
  const { privateKey } = await oidcKeys();
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}
