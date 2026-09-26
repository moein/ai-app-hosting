import type { z } from 'zod';
import { PlatformError } from './errors';
import { Logger } from './logger';

/**
 * Builds a memoized validator for a worker's `env` (FND-2.5). The first call per env object validates it;
 * a missing or malformed variable throws INTERNAL and logs the variable names — never their values.
 */
export function createEnvParser<S extends z.ZodType>(worker: string, schema: S): (env: object) => z.output<S> {
  const cache = new WeakMap<object, z.output<S>>();
  return (env) => {
    const cached = cache.get(env);
    if (cached !== undefined) return cached;
    const result = schema.safeParse(env);
    if (!result.success) {
      const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '(root)')))];
      Logger.root.error('invalid worker environment', { worker, variables });
      throw new PlatformError('INTERNAL');
    }
    cache.set(env, result.data);
    return result.data;
  };
}
