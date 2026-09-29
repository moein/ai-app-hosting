import { DENYLIST } from './denylist';
import { parseJsonc } from './jsonc';
import { RULES } from './rules';
import { compareVersions, minimumVersion, parseVersion } from './semver';
import {
  COMPATIBILITY_DATE_MAX,
  COMPATIBILITY_DATE_MIN,
  REQUIRED_DEPENDENCIES,
  SUPPORTED_CONTRACT_VERSIONS,
} from './version';

export type RuleId = (typeof RULES)[number]['id'];
export type Violation = { rule: RuleId; path: string; message: string; fix: string };
/** Text content, or `{ bytes }` for binary/large files whose content isn't needed. */
export type FileEntry = string | { bytes: number };

export const REQUIRED_FILES = [
  'package.json',
  'wrangler.jsonc',
  'vite.config.ts',
  'index.html',
  'tsconfig.json',
  'src/api/index.ts',
  'src/web/main.tsx',
] as const;

const FORBIDDEN_FILES = [
  'wrangler.toml',
  'wrangler.json',
  '.dev.vars',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];
const FORBIDDEN_DIRS = ['node_modules/', 'dist/'];
const ALLOWED_WRANGLER_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'assets',
  'd1_databases',
  'vars',
]);
const RESERVED_BINDINGS = new Set(['DB', 'FILES', 'ASSETS', 'EMAIL']);

const defaultFix = (rule: RuleId) =>
  (RULES.find((r) => r.id === rule)?.fix ?? '')
    .replace('{{COMPATIBILITY_DATE_MIN}}', COMPATIBILITY_DATE_MIN)
    .replace('{{COMPATIBILITY_DATE_MAX}}', COMPATIBILITY_DATE_MAX);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const denylisted = (name: string) =>
  DENYLIST.find((entry) =>
    entry.packages.some((pattern) =>
      pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    ),
  );

/** Checks an app's files against the contract and returns every violation (CON-4.1 – 4.3). */
export function validate(files: Map<string, FileEntry>): Violation[] {
  const violations: Violation[] = [];
  const add = (rule: RuleId, path: string, message: string, fix = defaultFix(rule)) =>
    violations.push({ rule, path, message, fix });
  const text = (path: string) => {
    const entry = files.get(path);
    return typeof entry === 'string' ? entry : undefined;
  };

  // CON-2.1 required files
  for (const path of REQUIRED_FILES) {
    if (!files.has(path))
      add('CON-R01', path, `Missing required file ${path}.`, `Create ${path} as described in the contract.`);
  }

  // CON-3.1 forbidden files
  for (const path of files.keys()) {
    const base = path.split('/').pop() ?? path;
    const forbidden =
      FORBIDDEN_FILES.includes(base) ||
      base === '.env' ||
      base.startsWith('.env.') ||
      FORBIDDEN_DIRS.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`));
    if (forbidden)
      add('CON-R14', path, `${path} must not be in the repository.`, `Delete ${path} with write_files (op "delete").`);
  }

  // CON-2.2 / CON-2.3 / CON-3.2 package.json
  const pkgText = text('package.json');
  if (pkgText !== undefined) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      add('CON-R02', 'package.json', 'package.json is not valid JSON.', 'Rewrite package.json as valid JSON.');
    }
    if (isObject(pkg)) {
      if (pkg.type !== 'module') add('CON-R02', 'package.json', 'package.json must have "type": "module".');
      if (pkg.private !== true) add('CON-R02', 'package.json', 'package.json must have "private": true.');
      const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
      if (scripts.build !== 'vite build') add('CON-R03', 'package.json', 'scripts.build must be exactly "vite build".');
      const deps = {
        ...(isObject(pkg.dependencies) ? pkg.dependencies : {}),
        ...(isObject(pkg.devDependencies) ? pkg.devDependencies : {}),
      };
      for (const required of REQUIRED_DEPENDENCIES) {
        const range = deps[required.name];
        const section = required.dev ? 'devDependencies' : 'dependencies';
        if (typeof range !== 'string') {
          add(
            'CON-R04',
            'package.json',
            `Missing required dependency ${required.name}.`,
            `Add "${required.name}"${required.min ? ` (≥ ${required.min})` : ''} to ${section}.`,
          );
          continue;
        }
        const min = minimumVersion(range);
        if (!min) {
          add(
            'CON-R04',
            'package.json',
            `${required.name} must be pinned to a version, not "${range}".`,
            `Use a version like "^${required.min ?? '1.0.0'}".`,
          );
        } else if (required.min && compareVersions(min, parseVersion(required.min)) < 0) {
          add(
            'CON-R04',
            'package.json',
            `${required.name} ${range} is below the minimum ${required.min}.`,
            `Use "${required.name}": "^${required.min}" or newer.`,
          );
        }
      }
      for (const name of Object.keys(deps)) {
        const entry = denylisted(name);
        if (entry)
          add(
            'CON-R15',
            'package.json',
            `${name} can't be used here (${entry.reason}).`,
            `Replace ${name} with ${entry.alternative}.`,
          );
      }
    }
  }

  // CON-2.4 / 2.5 / 3.3 / 3.4 wrangler.jsonc
  const wranglerText = text('wrangler.jsonc');
  if (wranglerText !== undefined) {
    let config: unknown;
    try {
      config = parseJsonc(wranglerText);
    } catch (error) {
      add('CON-R05', 'wrangler.jsonc', `wrangler.jsonc can't be parsed: ${(error as Error).message}`);
    }
    if (isObject(config)) {
      if (config.name !== 'app' || config.main !== 'src/api/index.ts') {
        add('CON-R06', 'wrangler.jsonc', 'wrangler.jsonc must have "name": "app" and "main": "src/api/index.ts".');
      }
      const date = config.compatibility_date;
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < COMPATIBILITY_DATE_MIN ||
        date > COMPATIBILITY_DATE_MAX
      ) {
        add('CON-R07', 'wrangler.jsonc', `compatibility_date ${JSON.stringify(date)} is outside the supported window.`);
      }
      const assets = isObject(config.assets) ? config.assets : {};
      const runFirst = Array.isArray(assets.run_worker_first) ? assets.run_worker_first : [];
      if (assets.not_found_handling !== 'single-page-application' || !runFirst.includes('/api/*')) {
        add(
          'CON-R08',
          'wrangler.jsonc',
          'assets must set not_found_handling "single-page-application" and run_worker_first ["/api/*"].',
        );
      }
      if ('binding' in assets)
        add('CON-R10', 'wrangler.jsonc', 'assets.binding must not be set; ASSETS is injected by the platform.');
      const d1 = Array.isArray(config.d1_databases) ? config.d1_databases : [];
      if (d1.length !== 1 || !isObject(d1[0]) || d1[0].binding !== 'DB') {
        add('CON-R09', 'wrangler.jsonc', 'wrangler.jsonc must declare exactly one D1 database with binding "DB".');
      }
      for (const key of Object.keys(config)) {
        if (!ALLOWED_WRANGLER_KEYS.has(key)) {
          add(
            'CON-R11',
            'wrangler.jsonc',
            `"${key}" is not supported in this contract version.`,
            `Remove "${key}" from wrangler.jsonc.`,
          );
        }
      }
      if (config.vars !== undefined) {
        if (!isObject(config.vars)) add('CON-R12', 'wrangler.jsonc', 'vars must be an object of string values.');
        else {
          for (const [name, value] of Object.entries(config.vars)) {
            if (typeof value !== 'string') add('CON-R12', 'wrangler.jsonc', `vars.${name} must be a string.`);
            if (RESERVED_BINDINGS.has(name)) {
              add('CON-R10', 'wrangler.jsonc', `vars.${name} uses a reserved binding name.`, `Rename vars.${name}.`);
            }
          }
        }
      }
    }
  }

  // CON-2.6 migrations
  const prefixes = new Map<string, string>();
  for (const path of files.keys()) {
    if (!path.startsWith('migrations/')) continue;
    const name = path.slice('migrations/'.length);
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) {
      add(
        'CON-R13',
        path,
        `${path} is not named NNNN_description.sql.`,
        'Rename it, e.g. migrations/0002_add_todos.sql.',
      );
      continue;
    }
    const other = prefixes.get(match[1] as string);
    if (other)
      add(
        'CON-R13',
        path,
        `${path} reuses the number ${match[1]} of ${other}.`,
        'Give every migration its own number.',
      );
    prefixes.set(match[1] as string, path);
  }

  // CON-2.8 index.html
  const html = text('index.html');
  if (
    html !== undefined &&
    !/<script[^>]*type=["']module["'][^>]*src=["']\/src\/web\/main\.tsx["']|<script[^>]*src=["']\/src\/web\/main\.tsx["'][^>]*type=["']module["']/.test(
      html,
    )
  ) {
    add('CON-R16', 'index.html', 'index.html does not load /src/web/main.tsx as a module script.');
  }

  // vite.config.ts plugins
  const vite = text('vite.config.ts');
  if (vite !== undefined && (!/\bcloudflare\s*\(/.test(vite) || !/\breact\s*\(/.test(vite))) {
    add('CON-R18', 'vite.config.ts', 'vite.config.ts must use the cloudflare() and react() plugins.');
  }

  // CON-4.6 platform.json
  const platform = text('platform.json');
  let version: unknown;
  try {
    version =
      platform === undefined ? undefined : (JSON.parse(platform) as { contract_version?: unknown }).contract_version;
  } catch {
    version = undefined;
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version as never)) {
    add('CON-R17', 'platform.json', `Unsupported or missing contract_version ${JSON.stringify(version)}.`);
  }

  return violations;
}
