import { NonRetryableError } from 'cloudflare:workflows';
import { PlatformError } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { fromStepError, stepBody, toStepError } from '../../src/workflows/step-errors';

describe('workflow step errors (spec 08 design)', () => {
  it('carries PlatformErrors across step boundaries as JSON, non-retryable ones stop retries', () => {
    const fatal = toStepError(new PlatformError('MIGRATION_FAILED', { details: { file: '0001_init.sql' } }));
    expect(fatal).toBeInstanceOf(NonRetryableError);
    const transient = toStepError(new PlatformError('UPSTREAM_ERROR'));
    expect(transient).not.toBeInstanceOf(NonRetryableError);
    expect(fromStepError(transient)?.code).toBe('UPSTREAM_ERROR');
  });

  it('recovers the error from the message the runtime hands back, prefix and all', () => {
    const json = JSON.stringify(new PlatformError('MIGRATION_FAILED', { details: { file: '0001_init.sql' } }).toJSON());
    for (const message of [json, `NonRetryableError: ${json}`, `Error: ${json}`]) {
      const recovered = fromStepError(new Error(message));
      expect(recovered?.code).toBe('MIGRATION_FAILED');
      expect(recovered?.details).toEqual({ file: '0001_init.sql' });
    }
    expect(fromStepError(new Error('PlatformError: Publishing the Worker failed.'))).toBeNull();
    expect(fromStepError(new Error('{"code":"NOT_A_CODE"}'))).toBeNull();
  });

  it('stepBody converts failures and passes successes through', async () => {
    await expect(stepBody(async () => {})()).resolves.toBeUndefined();
    await expect(
      stepBody(async () => {
        throw new PlatformError('MIGRATION_FAILED');
      })(),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});
