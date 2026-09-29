import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FLOW_ID = /F-[A-Z0-9]+-\d+/g;

/** Flow IDs listed in the catalog table of the spec (the source of truth). */
export function specFlowIds(designMarkdown: string): string[] {
  return [...designMarkdown.matchAll(/^\| `(F-[A-Z0-9]+-\d+)`/gm)].map((match) => match[1] as string);
}

/** Flow IDs tagged via `flow(...)` in e2e test sources. */
export function taggedFlowIds(testsDir: string): Set<string> {
  const tagged = new Set<string>();
  for (const file of readdirSync(testsDir).filter((name) => name.endsWith('.e2e.ts'))) {
    const source = readFileSync(join(testsDir, file), 'utf8');
    for (const call of source.matchAll(/flow\(\s*(\[[^\]]*\]|'[^']*')/g)) {
      for (const id of call[1]?.match(FLOW_ID) ?? []) tagged.add(id);
    }
  }
  return tagged;
}

export type SpecTool = { name: string; title: string; flags: string };

/** The tool table in specs/04-mcp-server/design.md: name, title and annotation letters (R, D, I, O). Every
 * tool requires the OAuth bearer token (spec 02, AUTH-4); there are no public tools any more. */
export function specTools(designMarkdown: string): SpecTool[] {
  return [...designMarkdown.matchAll(/^\| `([a-z_]+)` \| ([^|]+?) \| ([RDIO —]*) \|/gm)].map((match) => ({
    name: match[1] as string,
    title: (match[2] ?? '').trim(),
    flags: (match[3] ?? '').replace(/[^RDIO]/g, ''),
  }));
}
