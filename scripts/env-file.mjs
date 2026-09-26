// Reads the operator's git-ignored per-environment file `.env.<env>` (KEY=value lines). Values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const envFilePath = (env, root = process.cwd()) => resolve(root, `.env.${env}`);

export function readEnvFile(env, root = process.cwd()) {
  const path = envFilePath(env, root);
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
