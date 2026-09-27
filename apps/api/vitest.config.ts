import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { build } from 'esbuild';
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

// The real tail worker (hosts AppLogBuffer, bound here as APP_LOGS with script_name tail-dev), bundled for Miniflare.
async function tailWorkerScript(): Promise<string> {
  const result = await build({
    entryPoints: ['../tail/src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    external: ['cloudflare:*'],
    logLevel: 'silent',
  });
  return result.outputFiles[0]?.text ?? '';
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          LOGIN_CODE_PEPPER: 'test-pepper-0123456789abcdef0123456789abcdef',
          CF_API_TOKEN: 'test-cf-token',
          GITHUB_APP_ID: '1',
          GITHUB_INSTALLATION_ID: '1',
          GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
        },
        workers: [
          { name: 'email-dev', modules: true, script: EMAIL_STUB, compatibilityDate: '2026-08-22' },
          {
            name: 'tail-dev',
            modules: true,
            script: await tailWorkerScript(),
            compatibilityDate: '2026-08-22',
            bindings: { ENVIRONMENT: 'dev' },
            durableObjects: { APP_LOGS: { className: 'AppLogBuffer', useSQLite: true } },
          },
        ],
      },
    })),
  ],
  test: { setupFiles: ['./test/setup/apply-migrations.ts'] },
});
