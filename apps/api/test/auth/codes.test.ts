import { cryptoRandom } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { generateLoginCode, hashesEqual, hashLoginCode, normalizeEmail, stripCode } from '../../src/auth/codes';

describe('login code helpers (AUTH-1.2, AUTH-1.4, AUTH-2.2)', () => {
  it('generates 6-digit codes covering every digit, leading zeros kept', () => {
    const codes = Array.from({ length: 2_000 }, () => generateLoginCode(cryptoRandom));
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(codes.join('')).size).toBe(10);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('normalizes emails (trim + lowercase, +tags kept) and strips code separators', () => {
    expect(normalizeEmail('  A.B+Tag@Example.COM ')).toBe('a.b+tag@example.com');
    expect(stripCode('482 913')).toBe('482913');
    expect(stripCode('482-913')).toBe('482913');
  });

  it('hashes with HMAC-SHA256 keyed by the pepper and email', async () => {
    const hash = await hashLoginCode('pepper', 'a@b.co', '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashLoginCode('pepper', 'a@b.co', '123456')).toBe(hash);
    expect(await hashLoginCode('other', 'a@b.co', '123456')).not.toBe(hash);
    expect(await hashLoginCode('pepper', 'c@d.co', '123456')).not.toBe(hash);
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, hash.replace(/.$/, '0'))).toBe(hash.endsWith('0'));
    expect(hashesEqual(hash, 'short')).toBe(false);
  });
});
