// Reads the operator's git-ignored root .env (KEY=value lines). Values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readEnvFile(root = process.cwd()) {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
