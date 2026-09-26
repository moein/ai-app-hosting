import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readEnvFile } from '../scripts/env-file.mjs';

// E2E_* settings come from the environment, falling back to the git-ignored `.env.dev` (E2E-1.1).
for (const [key, value] of Object.entries(readEnvFile('dev', fileURLToPath(new URL('..', import.meta.url))))) {
  process.env[key] ??= value;
}

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
