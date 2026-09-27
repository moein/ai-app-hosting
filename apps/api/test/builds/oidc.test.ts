import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkBuildClaims, clearJwksCache, GITHUB_OIDC_ISSUER, verifyGitHubOidc } from '../../src/builds/oidc';
import { oidcKeys, signOidc, validClaims } from './oidc-helpers';

beforeAll(async () => {
  await oidcKeys();
});
afterEach(() => {
  clearJwksCache();
  vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 8, 27, 12);
const verify = async (token: string, fetchImpl?: typeof fetch) =>
  verifyGitHubOidc(token, { audience: 'https://api.test', now: NOW, fetch: fetchImpl ?? (await oidcKeys()).fetch });

describe('GitHub OIDC verification (DEP-2.1)', () => {
  it('accepts a valid token and returns its claims', async () => {
    const claims = await verify(await signOidc(validClaims(NOW)));
    expect(claims.iss).toBe(GITHUB_OIDC_ISSUER);
    expect(() => checkBuildClaims(claims, { org: 'AI-app-hosting', repo: 'dev-todo', repoId: 42 })).not.toThrow();
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'https://other' }],
    ['expiry', { exp: NOW / 1000 - 1 }],
  ])('rejects a wrong %s', async (_, override) => {
    await expect(verify(await signOidc({ ...validClaims(NOW), ...override }))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects a bad signature and malformed tokens', async () => {
    const token = await signOidc(validClaims(NOW));
    const [h, p] = token.split('.');
    const tampered = `${h}.${p?.slice(0, -2)}AA.${token.split('.')[2]}`;
    await expect(verify(tampered)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(verify('nope')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it.each([
    ['repository_id', { repository_id: '43' }],
    ['ref', { ref: 'refs/heads/feature' }],
    ['workflow_ref', { workflow_ref: 'AI-app-hosting/dev-todo/.github/workflows/other.yml@refs/heads/main' }],
    ['event_name', { event_name: 'pull_request' }],
    ['repository_owner', { repository_owner: 'someone-else' }],
  ])('rejects claims with the wrong %s', async (_, override) => {
    const claims = await verify(await signOidc({ ...validClaims(NOW), ...override }));
    expect(() => checkBuildClaims(claims, { org: 'AI-app-hosting', repo: 'dev-todo', repoId: 42 })).toThrow();
  });

  it('refetches the key set once for an unknown kid', async () => {
    const keys = await oidcKeys();
    const fetchSpy = vi.fn(keys.fetch);
    await verify(await signOidc(validClaims(NOW)), fetchSpy as unknown as typeof fetch);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await verify(await signOidc(validClaims(NOW), 'other-kid'), fetchSpy as unknown as typeof fetch).catch(() => {});
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
