import { createEnvParser } from '@repo/shared';
import { z } from 'zod';

export const parseEnv = createEnvParser('tail', z.object({ ENVIRONMENT: z.enum(['dev', 'prod']) }));
