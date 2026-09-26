import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser(
  'e2e-inbox',
  z.object({
    ENVIRONMENT: z.literal('dev'),
    E2E_INBOX_TOKEN: z.string().min(32),
  }),
);
