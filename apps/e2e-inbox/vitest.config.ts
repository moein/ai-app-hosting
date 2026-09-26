import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: { bindings: { E2E_INBOX_TOKEN: 'test-token-0123456789abcdef0123456789abcdef' } },
    }),
  ],
});
