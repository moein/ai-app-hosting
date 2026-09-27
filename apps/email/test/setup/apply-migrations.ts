import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// FND-6.2: every test file starts from a D1 with all migrations applied (storage is isolated per test file).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
