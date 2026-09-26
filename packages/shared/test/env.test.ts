import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createEnvParser } from '../src/env';
import { PlatformError } from '../src/errors';

const schema = z.object({ ENVIRONMENT: z.enum(['dev', 'prod']), API_ORIGIN: z.url() });

describe('createEnvParser', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the parsed variables and memoizes per env object', () => {
    const parse = createEnvParser('test', schema);
    const env = { ENVIRONMENT: 'dev', API_ORIGIN: 'https://example.com', SOME_BINDING: {} };
    const first = parse(env);
    expect(first).toEqual({ ENVIRONMENT: 'dev', API_ORIGIN: 'https://example.com' });
    expect(parse(env)).toBe(first);
  });

  it('throws INTERNAL and logs only the names of invalid variables', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const parse = createEnvParser('test', schema);
    let thrown: unknown;
    try {
      parse({ ENVIRONMENT: 'staging', API_ORIGIN: 'super-secret-value' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PlatformError);
    expect((thrown as PlatformError).code).toBe('INTERNAL');
    const logged = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      level: 'error',
      message: 'invalid worker environment',
      worker: 'test',
      variables: ['ENVIRONMENT', 'API_ORIGIN'],
    });
    expect(logged).not.toContain('super-secret-value');
    expect(logged).not.toContain('staging');
  });
});
