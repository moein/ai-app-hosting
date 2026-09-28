import { NonRetryableError } from 'cloudflare:workflows';
import { ERROR_CATALOG, PlatformError, type PlatformErrorJson, platformErrorFromJson } from '@repo/shared';

/**
 * Workflows only carry an error's message across a step boundary (prefixed with the error's class name, e.g.
 * "NonRetryableError: …"), so PlatformErrors travel as JSON in the message. Non-retryable ones stop the retries.
 */
export function toStepError(error: unknown): Error {
  if (error instanceof PlatformError) {
    const json = JSON.stringify(error.toJSON());
    return error.retryable ? new Error(json) : new NonRetryableError(json);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The PlatformError behind an error that came out of a workflow step, or null if it wasn't one. */
export function fromStepError(error: unknown): PlatformError | null {
  if (error instanceof PlatformError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const start = message.indexOf('{');
  if (start === -1) return null;
  try {
    const json = JSON.parse(message.slice(start)) as PlatformErrorJson;
    return typeof json?.code === 'string' && json.code in ERROR_CATALOG ? platformErrorFromJson(json) : null;
  } catch {
    return null;
  }
}

/** Runs a step body, converting its failure with `toStepError`. */
export const stepBody = (run: () => Promise<void>) => async () => {
  try {
    await run();
  } catch (error) {
    throw toStepError(error);
  }
};
