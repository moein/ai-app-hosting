// Uploads Worker secrets for one environment from the root .env: node scripts/set-secrets.mjs <dev|prod>
// Values go to wrangler via stdin and are never printed.
import { execFileSync } from 'node:child_process';
import { readEnvFile } from './env-file.mjs';

// worker -> { SECRET_NAME: KEY_IN_.env }
const SECRETS = {
  email: {
    RESEND_API_KEY: 'RESEND_API_KEY',
    AWS_ACCESS_KEY_ID: 'AWS_ACCESS_KEY',
    AWS_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY',
  },
};

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  process.stderr.write('usage: node scripts/set-secrets.mjs <dev|prod>\n');
  process.exit(1);
}

const values = readEnvFile();
for (const [worker, mapping] of Object.entries(SECRETS)) {
  const payload = {};
  for (const [secret, key] of Object.entries(mapping)) {
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
