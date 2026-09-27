import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outdatedPackages, unpinnedDependencies } from './deps-check-lib.mjs';

test('reports outdated packages except intentional pins', () => {
  const outdated = {
    hono: { current: '4.13.0', latest: '4.13.9', dependentPackages: [{ name: '@repo/api' }] },
    vitest: { current: '4.1.11', latest: '5.0.2', dependentPackages: [] },
    zod: { current: '4.6.5', latest: '4.6.5', dependentPackages: [] },
  };
  assert.deepEqual(outdatedPackages(outdated, { vitest: 'peer' }), [
    { name: 'hono', current: '4.13.0', latest: '4.13.9', usedBy: ['@repo/api'] },
  ]);
});

test('flags ranges but accepts exact versions and workspace links', () => {
  const manifest = {
    dependencies: { a: '1.2.3', b: '^1.2.3', c: 'workspace:*', d: '1.0.0-beta.1' },
    devDependencies: { e: '~2.0.0', f: 'latest' },
  };
  assert.deepEqual(unpinnedDependencies(manifest), [
    { section: 'dependencies', name: 'b', spec: '^1.2.3' },
    { section: 'devDependencies', name: 'e', spec: '~2.0.0' },
    { section: 'devDependencies', name: 'f', spec: 'latest' },
  ]);
});
