import { defineConfig } from 'vitest/config';

// Plain Vitest: the Worker is tested with a fake ASSETS binding; UI tests opt into happy-dom per file.
export default defineConfig({ test: { include: ['test/**/*.test.{ts,tsx}'] } });
