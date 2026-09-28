// Terminal deploys with the locally authenticated wrangler (FND-7): node scripts/deploy.mjs <dev|prod>
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readEnvFile } from './env-file.mjs';

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  process.stderr.write('usage: node scripts/deploy.mjs <dev|prod>\n');
  process.exit(1);
}

const say = (message) => process.stdout.write(`\n▶ ${message}\n`);
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

try {
  if (env === 'prod') {
    say('checking git state');
    if (output('git', ['status', '--porcelain']) !== '') throw new Error('working tree is not clean');
    if (output('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new Error('HEAD is not on main');
    run('git', ['fetch', 'origin', 'main', '--quiet']);
    if (output('git', ['rev-parse', 'HEAD']) !== output('git', ['rev-parse', 'origin/main'])) {
      throw new Error('main is not pushed to origin (HEAD differs from origin/main)');
    }
  }

  say('checks');
  for (const script of ['check:wrangler', 'lint', 'typecheck', 'test']) run('pnpm', ['run', '--silent', script]);

  if (existsSync('apps/api/migrations')) {
    say(`platform D1 migrations (${env})`);
    run('pnpm', [
      '--filter',
      '@repo/api',
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--env',
      env,
      '--remote',
    ]);
  }

  const workers = ['email', 'tail', 'api', 'dispatcher', 'website', ...(env === 'dev' ? ['e2e-inbox'] : [])];
  for (const worker of workers.filter((w) => existsSync(`apps/${w}/wrangler.jsonc`))) {
    say(`deploy ${worker} (${env})`);
    // Each worker's deploy:<env> script (the website builds with Vite first).
    run('pnpm', ['--filter', `@repo/${worker}`, 'run', `deploy:${env}`]);
  }

  if (env === 'dev' && existsSync('e2e/package.json')) {
    say('e2e against dev');
    run('pnpm', ['--filter', '@repo/e2e', 'run', 'e2e'], { env: { ...process.env, ...readEnvFile('dev') } });
  }

  say(`deployed ${env}`);
} catch (error) {
  process.stderr.write(`\n✖ deploy ${env} failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
