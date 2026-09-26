import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, PlatformError } from '../src/errors';
import { randomString } from '../src/random';
import { generateSlug, orgNameFromEmail, RESERVED_SLUGS, randomSuffix, slugBase, validateSlug } from '../src/slugs';
import { fixedRandom, seededRandom } from './seeded-random';

const never = async () => false;

describe('validateSlug (SLUG-1)', () => {
  it.each([
    ['abc', true],
    ['my-todo-app', true],
    ['a'.repeat(63), true],
    ['a1b2', true],
  ])('accepts %s', (slug) => expect(validateSlug(slug)).toEqual({ ok: true }));

  it.each([
    ['ab', 'too_short'],
    ['', 'too_short'],
    ['a'.repeat(64), 'too_long'],
    ['My-app', 'invalid_chars'],
    ['my_app', 'invalid_chars'],
    ['my.app', 'invalid_chars'],
    ['1app', 'invalid_start'],
    ['-app', 'invalid_start'],
    ['app-', 'invalid_end'],
    ['my--app', 'double_hyphen'],
    ['xn--abc', 'double_hyphen'],
    ['api', 'reserved'],
  ] as const)('rejects %j as %s', (slug, reason) => expect(validateSlug(slug)).toEqual({ ok: false, reason }));

  it('applies rules in order (length before characters before start/end)', () => {
    expect(validateSlug('A')).toEqual({ ok: false, reason: 'too_short' });
    expect(validateSlug('1_x')).toEqual({ ok: false, reason: 'invalid_chars' });
  });

  it.each([...RESERVED_SLUGS])('reserves %s', (slug) => {
    const result = validateSlug(slug);
    // a few reserved words are shorter than 3 characters or contain hyphens; they are still never allowed
    expect(result.ok).toBe(false);
  });
});

describe('slugBase / orgNameFromEmail (SLUG-2.1 – 2.4, 2.7)', () => {
  it.each([
    ['My Todo App', 'app', 'my-todo-app', false],
    ['Café Crème!!', 'app', 'cafe-creme', false],
    ['2048 Game', 'app', 'app-2048-game', false],
    ['🍕', 'app', 'app', true],
    ['--Hello__World--', 'org', 'hello-world', false],
    ['ab', 'org', 'org', true],
  ] as const)('%j (%s) → %s', (name, kind, base, forceSuffix) => {
    expect(slugBase(name, kind)).toEqual({ base, forceSuffix });
  });

  it('truncates to 58 characters without a trailing hyphen', () => {
    const { base } = slugBase(`${'a'.repeat(57)} b${'c'.repeat(100)}`, 'app');
    expect(base.length).toBeLessThanOrEqual(58);
    expect(base.endsWith('-')).toBe(false);
  });

  it('uses the email local part without +tag', () => {
    expect(orgNameFromEmail('moein+test@tropee.com')).toBe('moein');
    expect(orgNameFromEmail('e2e+abc-1@motad.app')).toBe('e2e');
  });
});

describe('random suffix', () => {
  it('is 4 characters from [0-9a-z]', () => {
    for (let seed = 0; seed < 200; seed++) expect(randomSuffix(seededRandom(seed))).toMatch(/^[0-9a-z]{4}$/);
  });

  it('rejects biased bytes (≥ 252) instead of wrapping them', () => {
    expect(randomString(fixedRandom([255, 253, 252, 0, 1, 35, 36]), '0123456789abcdefghijklmnopqrstuvwxyz', 4)).toBe(
      '01z0',
    );
  });
});

describe('generateSlug (SLUG-2.5, SLUG-2.6)', () => {
  it('returns the base when it is free', async () => {
    expect(await generateSlug('My Todo App', 'app', never, seededRandom())).toBe('my-todo-app');
  });

  it('suffixes a taken base', async () => {
    const slug = await generateSlug('todo', 'app', async (s) => s === 'todo', seededRandom());
    expect(slug).toMatch(/^todo-[0-9a-z]{4}$/);
  });

  it('suffixes a reserved base', async () => {
    expect(await generateSlug('API', 'app', never, seededRandom())).toMatch(/^api-[0-9a-z]{4}$/);
  });

  it('forces a suffix for names without usable characters', async () => {
    expect(await generateSlug('🍕', 'app', never, seededRandom())).toMatch(/^app-[0-9a-z]{4}$/);
  });

  it('fails with INTERNAL after 5 collisions', async () => {
    const attempts: string[] = [];
    const taken = async (s: string) => {
      attempts.push(s);
      return true;
    };
    await expect(generateSlug('todo', 'app', taken, seededRandom())).rejects.toBeInstanceOf(PlatformError);
    expect(attempts).toHaveLength(5);
  });

  it('always yields valid slugs for arbitrary Unicode names', async () => {
    const random = seededRandom(7);
    for (let i = 0; i < 1_000; i++) {
      const bytes = random.bytes(12);
      const name = String.fromCodePoint(...[...bytes].map((b) => (b % 3 === 0 ? 0x1f300 + b : 0x20 + b * 3)));
      const slug = await generateSlug(name, i % 2 ? 'app' : 'org', never, random);
      expect(validateSlug(slug), `${JSON.stringify(name)} → ${slug}`).toEqual({ ok: true });
    }
  });
});

describe('slug error codes (SLUG-4.1, SLUG-4.2)', () => {
  it.each(['SLUG_INVALID', 'SLUG_UNAVAILABLE'] as const)('%s has a hint', (code) => {
    expect(ERROR_CATALOG[code].hint.length).toBeGreaterThan(0);
  });
});
