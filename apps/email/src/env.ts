import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser(
  'email',
  z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']),
    PLATFORM_MAIL_DOMAIN: z.string().min(1),
    APPS_MAIL_DOMAIN: z.string().min(1),
    AWS_REGION: z.string().min(1),
    SES_CONFIGURATION_SET: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    AWS_ACCESS_KEY_ID: z.string().min(1),
    AWS_SECRET_ACCESS_KEY: z.string().min(1),
  }),
);

export type ParsedEnv = ReturnType<typeof parseEnv>;
