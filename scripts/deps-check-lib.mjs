// FND-5: exact pins, and nothing behind the latest stable version unless the pin is intentional.

/** Intentional pins, with the reason. Remove an entry once the constraint is gone. */
export const INTENTIONAL_PINS = {
  '@modelcontextprotocol/sdk': 'agents 0.24.0 requires exactly 1.30.0 (peer dependency)',
  vitest: '@cloudflare/vitest-pool-workers 0.22 requires vitest ^4.1',
  '@types/node': 'types follow the Node LTS line we run (24.x)',
};

/** Outdated packages from `pnpm outdated -r --format json`, minus intentional pins. */
export function outdatedPackages(outdatedJson, pins = INTENTIONAL_PINS) {
  return Object.entries(outdatedJson)
    .filter(([name, info]) => info.current !== info.latest && !(name in pins))
    .map(([name, info]) => ({
      name,
      current: info.current,
      latest: info.latest,
      usedBy: (info.dependentPackages ?? []).map((p) => p.name),
    }));
}

/** Dependency specs that aren't exact versions (FND-5.1); workspace links are fine. */
export function unpinnedDependencies(packageJson) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  return sections.flatMap((section) =>
    Object.entries(packageJson[section] ?? {})
      .filter(([, spec]) => !spec.startsWith('workspace:') && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec))
      .map(([name, spec]) => ({ section, name, spec })),
  );
}
