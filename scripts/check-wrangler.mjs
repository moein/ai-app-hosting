// FND-2.2: every worker is configured with wrangler.jsonc; wrangler.toml / wrangler.json must not exist.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const offending = files.filter((file) => ['wrangler.toml', 'wrangler.json'].includes(basename(file)));

if (offending.length > 0) {
  process.stderr.write(`Use wrangler.jsonc instead of:\n${offending.map((file) => `  ${file}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('wrangler config check passed\n');
