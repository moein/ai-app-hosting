import { describe, expect, it } from 'vitest';
import { PlatformError } from '../src/errors';
import { parseDuration } from '../src/time';

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    [' 5m ', 300_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '15', 'm', '1.5h', '-1h', '1w', '15 m', '1234567s'])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(PlatformError);
    try {
      parseDuration(input);
    } catch (error) {
      expect((error as PlatformError).code).toBe('INVALID_INPUT');
    }
  });
});
