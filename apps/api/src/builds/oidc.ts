import { PlatformError } from '@repo/shared';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 3_600_000;

export type GitHubOidcClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  repository: string;
  repository_id: string;
  repository_owner: string;
  ref: string;
  workflow_ref: string;
  event_name: string;
  run_id?: string;
  sha?: string;
};

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | undefined;

async function jwks(fetchImpl: typeof fetch, now: number, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetchImpl(JWKS_URL);
  if (!response.ok) throw new PlatformError('UPSTREAM_ERROR', { message: 'Could not load GitHub OIDC keys.' });
  jwksCache = { keys: ((await response.json()) as { keys: Jwk[] }).keys, fetchedAt: now };
  return jwksCache.keys;
}

/** Test hook: forget cached signing keys. */
export const clearJwksCache = () => {
  jwksCache = undefined;
};

const decodePart = (part: string) =>
  JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))),
  );
const bytes = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const unauthorized = (reason: string) =>
  new PlatformError('AUTH_REQUIRED', {
    message: `Invalid build token: ${reason}.`,
    hint: 'Only the managed deploy workflow can call this endpoint.',
  });

/** Verifies a GitHub Actions OIDC token's RS256 signature (JWKS, refetched once on an unknown kid), issuer, audience and expiry. */
export async function verifyGitHubOidc(
  token: string,
  options: { audience: string; now: number; fetch?: typeof fetch },
): Promise<GitHubOidcClaims> {
  const fetchImpl = options.fetch ?? fetch;
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('malformed');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: GitHubOidcClaims;
  try {
    header = decodePart(headerPart);
    claims = decodePart(payloadPart);
  } catch {
    throw unauthorized('malformed');
  }
  if (header.alg !== 'RS256' || !header.kid) throw unauthorized('unsupported algorithm');

  let key = (await jwks(fetchImpl, options.now)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(fetchImpl, options.now, true)).find((k) => k.kid === header.kid);
  if (!key) throw unauthorized('unknown signing key');

  const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    bytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw unauthorized('bad signature');
  if (claims.iss !== GITHUB_OIDC_ISSUER) throw unauthorized('wrong issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) throw unauthorized('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= options.now) throw unauthorized('expired');
  return claims;
}

/** DEP-2.1: the token must come from the app's own repo, main branch, managed workflow, push or dispatch. */
export function checkBuildClaims(claims: GitHubOidcClaims, expected: { org: string; repo: string; repoId: number }) {
  const ownerOk = claims.repository_owner.toLowerCase() === expected.org.toLowerCase();
  const repoOk = claims.repository_id === String(expected.repoId);
  const refOk = claims.ref === 'refs/heads/main';
  const workflowOk =
    claims.workflow_ref.toLowerCase() ===
    `${expected.org}/${expected.repo}/.github/workflows/deploy.yml@refs/heads/main`.toLowerCase();
  const eventOk = claims.event_name === 'push' || claims.event_name === 'workflow_dispatch';
  if (!(ownerOk && repoOk && refOk && workflowOk && eventOk))
    throw unauthorized('not the managed workflow of this app');
}
