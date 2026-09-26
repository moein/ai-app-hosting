import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, isId, newId } from '../src/ids';

const FORMAT = /^(usr|org|app|dep|evt|lc)_[A-Za-z0-9_-]{11}$/;

describe('newId', () => {
  it.each(ID_PREFIXES)('creates "%s" IDs in the documented format', (prefix) => {
    const id = newId(prefix);
    expect(id).toMatch(FORMAT);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('app')));
    expect(ids.size).toBe(10_000);
  });
});

describe('isId', () => {
  it('accepts IDs with the requested prefix', () => {
    expect(isId(newId('usr'), 'usr')).toBe(true);
    expect(isId('usr_V1StGXR8_Z5', 'usr')).toBe(true);
    expect(isId('lc_-abc_DEF-12', 'lc')).toBe(true);
  });

  it.each([
    ['wrong prefix', 'org_V1StGXR8_Z5'],
    ['too short', 'usr_V1StGXR8_Z'],
    ['too long', 'usr_V1StGXR8_Z55'],
    ['illegal characters', 'usr_V1StGXR8.Z5'],
    ['missing separator', 'usrV1StGXR8_Z5'],
    ['empty', ''],
  ])('rejects %s', (_, value) => {
    expect(isId(value, 'usr')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isId(42, 'usr')).toBe(false);
    expect(isId(undefined, 'usr')).toBe(false);
  });
});
