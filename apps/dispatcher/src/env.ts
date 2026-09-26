import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser(
  'dispatcher',
  z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']),
    APPS_DOMAIN: z.string().min(1),
    PLATFORM_WEBSITE_URL: z.union([z.literal(''), z.url()]),
  }),
);
