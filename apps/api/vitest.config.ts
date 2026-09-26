import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Stand-in for the email worker's PlatformMail entrypoint (the MAIL service binding). Tool tests inject
// their own fake mailer through the tool context; this only lets the runtime start.
const EMAIL_STUB = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class PlatformMail extends WorkerEntrypoint {
  async sendLoginCode() { return { ok: true, id: 'stub' }; }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          LOGIN_CODE_PEPPER: 'test-pepper-0123456789abcdef0123456789abcdef',
        },
        workers: [{ name: 'email-dev', modules: true, script: EMAIL_STUB, compatibilityDate: '2026-08-22' }],
      },
    })),
  ],
  test: { setupFiles: ['./test/setup/apply-migrations.ts'] },
});
