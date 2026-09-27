import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser(
  'api',
  z.object({
    ENVIRONMENT: z.enum(['dev', 'prod']),
    CF_ACCOUNT_ID: z.string().min(1),
    PLATFORM_API_ORIGIN: z.url(),
    APPS_DOMAIN: z.string().min(1),
    GITHUB_ORG: z.string().min(1),
    LOGIN_CODE_PEPPER: z.string().min(32),
    CF_API_TOKEN: z.string().min(1),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_INSTALLATION_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  }),
);
