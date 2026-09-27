// pnpm deps:check — fails when a dependency isn't pinned exactly or is behind the latest stable version (FND-5).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { INTENTIONAL_PINS, outdatedPackages, unpinnedDependencies } from './deps-check-lib.mjs';

const manifests = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*package.json'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('package.json') && !file.includes('node_modules'));

const problems = [];
for (const file of manifests) {
  for (const { section, name, spec } of unpinnedDependencies(JSON.parse(readFileSync(file, 'utf8')))) {
    problems.push(`${file}: ${section}.${name} is "${spec}" — pin an exact version`);
  }
}

let outdatedJson = {};
try {
  outdatedJson = JSON.parse(execFileSync('pnpm', ['outdated', '-r', '--format', 'json'], { encoding: 'utf8' }) || '{}');
} catch (error) {
  // pnpm outdated exits 1 when something is outdated; its JSON is still on stdout.
  outdatedJson = JSON.parse(error.stdout || '{}');
}
for (const { name, current, latest, usedBy } of outdatedPackages(outdatedJson)) {
  problems.push(`${name} ${current} → ${latest} (${usedBy.join(', ')})`);
}

for (const [name, reason] of Object.entries(INTENTIONAL_PINS))
  process.stdout.write(`pinned on purpose: ${name} — ${reason}\n`);
if (problems.length > 0) {
  process.stderr.write(`\n${problems.length} dependency problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('dependencies are pinned and up to date\n');
