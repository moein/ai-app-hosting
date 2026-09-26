import * as limits from '@repo/shared/limits';
import { DENYLIST } from './denylist';
import { GUIDE_SOURCES } from './guide-sources.generated';
import { RULES } from './rules';
import { COMPATIBILITY_DATE_MAX, COMPATIBILITY_DATE_MIN, CONTRACT_VERSION, REQUIRED_DEPENDENCIES } from './version';

export type GuideTopic = keyof typeof GUIDE_SOURCES;
export const GUIDE_TOPICS = Object.keys(GUIDE_SOURCES) as GuideTopic[];

const LIMITS = limits as unknown as Record<string, number>;

/** Human size: exact binary units first (25 MiB), then decimal (5 MB). */
export function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1024 * 1024, 'MiB'],
    [1_000_000, 'MB'],
    [1024, 'KiB'],
    [1_000, 'KB'],
  ];
  for (const [size, unit] of units) if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`;
  return `${bytes.toLocaleString('en-US')} bytes`;
}

const table = (header: string[], rows: string[][]) =>
  [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

const BLOCKS: Record<string, () => string> = {
  RULES: () =>
    table(
      ['Rule', 'Requirement', 'Fix'],
      RULES.map((r) => [`\`${r.id}\``, r.rule, r.fix]),
    ),
  DENYLIST: () =>
    table(
      ['Packages', 'Why', 'Use instead'],
      DENYLIST.map((d) => [d.packages.map((p) => `\`${p}\``).join(', '), d.reason, d.alternative]),
    ),
  REQUIRED_DEPENDENCIES: () =>
    table(
      ['Package', 'Minimum version', 'Section'],
      REQUIRED_DEPENDENCIES.map((d) => [`\`${d.name}\``, d.min ?? 'any', d.dev ? 'devDependencies' : 'dependencies']),
    ),
};

function fill(markdown: string, appsDomain: string): string {
  const scalars: Record<string, string> = {
    CONTRACT_VERSION,
    COMPATIBILITY_DATE_MIN,
    COMPATIBILITY_DATE_MAX,
    APPS_DOMAIN: appsDomain,
  };
  const withBlocks = markdown.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => BLOCKS[name]?.() ?? match);
  return withBlocks.replace(/\{\{(bytes:)?([A-Z_]+)\}\}/g, (match, bytes: string | undefined, name: string) => {
    if (!bytes && name in scalars) return scalars[name] as string;
    const value = LIMITS[name];
    if (typeof value !== 'number') throw new Error(`Unknown guide placeholder ${match}`);
    return bytes ? formatBytes(value) : value.toLocaleString('en-US');
  });
}

/** The guide for one topic, or every topic in order for `all` (MCP-2.2, MCP-2.3). */
export function renderGuide(topic: GuideTopic | 'all', options: { appsDomain: string }): string {
  const topics = topic === 'all' ? GUIDE_TOPICS : [topic];
  return topics.map((t) => fill(GUIDE_SOURCES[t], options.appsDomain).trim()).join('\n\n---\n\n');
}
