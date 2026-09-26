import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/db/schema.ts into migrations/ (applied with `wrangler d1 migrations apply`).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
});
