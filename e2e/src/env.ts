import { z } from 'zod';

const schema = z.object({
  E2E_API_ORIGIN: z.url(),
  E2E_APPS_DOMAIN: z.string().min(1),
  E2E_INBOX_ORIGIN: z.url(),
  E2E_INBOX_TOKEN: z.string().min(32),
  E2E_INBOX_ADDRESS: z.email(),
  E2E_INCLUDE_SLOW: z.enum(['0', '1']).default('0'),
  // Only for the inbox self-test (F-E2E-1): sends a probe through Resend.
  RESEND_API_KEY: z.string().optional(),
  E2E_PROBE_FROM: z.email().optional(),
  // Read-only checks of platform data (F-USG-1, F-EVT-1); falls back to the operator's CF_API_TOKEN.
  E2E_CF_API_TOKEN: z.string().optional(),
  CF_API_TOKEN: z.string().optional(),
});

export type E2eEnv = z.infer<typeof schema>;

let cached: E2eEnv | undefined;

/** The harness configuration; fails fast with the names of missing/invalid variables. */
export function e2eEnv(): E2eEnv {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid e2e configuration (set in .env or the environment): ${names.join(', ')}`);
  }
  cached = result.data;
  return cached;
}
