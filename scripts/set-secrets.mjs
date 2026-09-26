// Uploads Worker secrets for one environment from the root .env: node scripts/set-secrets.mjs <dev|prod>
// Values go to wrangler via stdin and are never printed. Secrets marked `generate` are created (random) and
// appended to .env when missing, so tools that need them (e.g. the e2e harness) can read them too.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { readEnvFile } from './env-file.mjs';

// worker -> { SECRET_NAME: { key: KEY_IN_.env, envs?: [...], generate?: true } }
// `{ENV}` in a key is replaced by DEV / PROD, so each environment gets its own value.
const SECRETS = {
  api: {
    LOGIN_CODE_PEPPER: { key: 'LOGIN_CODE_PEPPER_{ENV}', generate: true },
  },
  email: {
    RESEND_API_KEY: { key: 'RESEND_API_KEY' },
    AWS_ACCESS_KEY_ID: { key: 'AWS_ACCESS_KEY' },
    AWS_SECRET_ACCESS_KEY: { key: 'AWS_SECRET_ACCESS_KEY' },
  },
  'e2e-inbox': {
    E2E_INBOX_TOKEN: { key: 'E2E_INBOX_TOKEN', envs: ['dev'], generate: true },
  },
};

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  process.stderr.write('usage: node scripts/set-secrets.mjs <dev|prod>\n');
  process.exit(1);
}

const values = readEnvFile();
for (const [worker, secrets] of Object.entries(SECRETS)) {
  if (!existsSync(`apps/${worker}/wrangler.jsonc`)) continue;
  const payload = {};
  for (const [secret, { key: template, envs, generate }] of Object.entries(secrets)) {
    if (envs && !envs.includes(env)) continue;
    const key = template.replace('{ENV}', env.toUpperCase());
    if (!values[key] && generate) {
      values[key] = randomBytes(32).toString('hex');
      appendFileSync('.env', `\n${key}=${values[key]}\n`);
      process.stdout.write(`generated ${key} and saved it to .env\n`);
    }
    if (!values[key]) {
      process.stderr.write(`skipping ${worker}.${secret}: ${key} is not set in .env\n`);
      continue;
    }
    payload[secret] = values[key];
  }
  if (Object.keys(payload).length === 0) continue;
  process.stdout.write(`setting ${Object.keys(payload).join(', ')} on ${worker}-${env}\n`);
  execFileSync('pnpm', ['--filter', `@repo/${worker}`, 'exec', 'wrangler', 'secret', 'bulk', '--env', env], {
    input: JSON.stringify(payload),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}
