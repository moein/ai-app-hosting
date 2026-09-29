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
    /** R2's S3-compatible API for object-level operations (spec 15): CF_API_TOKEN only reaches bucket lifecycle. */
    R2_ACCESS_KEY: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_INSTALLATION_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
    SES_EVENTS_TOPIC_ARN: z.string().startsWith('arn:aws:sns:').optional(),
    /** Dev only (spec 12): the e2e inbox; enables the hourly e2e purge. Never set in prod. */
    E2E_INBOX_ADDRESS: z.email().optional(),
  }),
);
