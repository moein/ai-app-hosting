import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOW_CATALOG } from '../src/catalog';
import { specFlowIds, taggedFlowIds } from '../src/coverage';

const repo = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

describe('flow coverage (E2E-3)', () => {
  it('the harness catalog mirrors the spec catalog', () => {
    const spec = specFlowIds(readFileSync(repo('specs/12-e2e-testing/design.md'), 'utf8'));
    expect(Object.keys(FLOW_CATALOG).sort()).toEqual([...spec].sort());
  });

  it('every implemented flow has at least one tagged e2e test', () => {
    const tagged = taggedFlowIds(repo('e2e/tests'));
    const missing = Object.entries(FLOW_CATALOG)
      .filter(([id, { implemented }]) => implemented && !tagged.has(id))
      .map(([id]) => id);
    expect(missing, `implemented flows without an e2e test: ${missing.join(', ')}`).toEqual([]);
  });

  it('tests only tag flows that exist in the catalog', () => {
    const unknown = [...taggedFlowIds(repo('e2e/tests'))].filter((id) => !(id in FLOW_CATALOG));
    expect(unknown).toEqual([]);
  });
});
