import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          RESEND_API_KEY: 're_test_key',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          CF_API_TOKEN: 'test-cf-token',
          // The api owns the platform schema; apply its migrations to the test D1.
          TEST_MIGRATIONS: await readD1Migrations('../api/migrations'),
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/setup/apply-migrations.ts'] },
});
