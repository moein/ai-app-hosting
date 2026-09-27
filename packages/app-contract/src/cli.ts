// Contract validator CLI (CON-4.4): `node validator.mjs <dir>` prints {"violations":[…]}; exit 1 if any.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type FileEntry, validate } from './validate';

const MAX_TEXT_BYTES = 1_000_000;

function collect(root: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      const path = relative(root, full).split('\\').join('/');
      const stats = statSync(full);
      if (stats.isDirectory()) {
        // Forbidden directories only need to be seen, not read.
        if (name === 'node_modules' || name === 'dist') files.set(`${path}/`, { bytes: 0 });
        else walk(full);
      } else {
        files.set(path, stats.size <= MAX_TEXT_BYTES ? readFileSync(full, 'utf8') : { bytes: stats.size });
      }
    }
  };
  walk(root);
  return files;
}

const violations = validate(collect(process.argv[2] ?? '.'));
process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`);
process.exit(violations.length > 0 ? 1 : 0);
