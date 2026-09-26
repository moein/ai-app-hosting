import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser(
  'email',
  z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']),
    PLATFORM_MAIL_DOMAIN: z.string().min(1),
    APPS_MAIL_DOMAIN: z.string().min(1),
    AWS_REGION: z.string().min(1),
  }),
);
