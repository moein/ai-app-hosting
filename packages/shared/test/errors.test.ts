import { describe, expect, it } from 'vitest';
import { ERROR_CATALOG, type ErrorCode, PlatformError, toPlatformError } from '../src/errors';

describe('ERROR_CATALOG', () => {
  it.each(Object.keys(ERROR_CATALOG) as ErrorCode[])('%s has a message and a non-empty hint', (code) => {
    expect(ERROR_CATALOG[code].message.length).toBeGreaterThan(0);
    expect(ERROR_CATALOG[code].hint.length).toBeGreaterThan(0);
  });
});

describe('PlatformError', () => {
  it('serializes to the caller-facing shape with catalog defaults', () => {
    const error = new PlatformError('RATE_LIMITED', { details: { retry_after_seconds: 30 } });
    expect(error.toJSON()).toEqual({
      code: 'RATE_LIMITED',
      message: ERROR_CATALOG.RATE_LIMITED.message,
      hint: ERROR_CATALOG.RATE_LIMITED.hint,
      retryable: true,
      details: { retry_after_seconds: 30 },
    });
  });

  it('allows overriding message and hint', () => {
    const json = new PlatformError('NOT_FOUND', { message: 'No app "todo".', hint: 'Call list_apps.' }).toJSON();
    expect(json.message).toBe('No app "todo".');
    expect(json.hint).toBe('Call list_apps.');
    expect(json).not.toHaveProperty('details');
  });
});

describe('toPlatformError', () => {
  it('passes PlatformErrors through unchanged', () => {
    const error = new PlatformError('CONFLICT');
    expect(toPlatformError(error)).toBe(error);
  });

  it('turns unknown errors into a generic INTERNAL without leaking internals', () => {
    const cause = new Error('D1_ERROR: no such table: secret_internal_table');
    const json = toPlatformError(cause).toJSON();
    expect(json.code).toBe('INTERNAL');
    expect(json.message).toBe(ERROR_CATALOG.INTERNAL.message);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('secret_internal_table');
    expect(serialized).not.toContain('stack');
  });

  it('keeps the original error as cause for logging', () => {
    const cause = new Error('boom');
    expect(toPlatformError(cause).cause).toBe(cause);
  });
});
