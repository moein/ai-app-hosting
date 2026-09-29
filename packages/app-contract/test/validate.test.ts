import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundleValidator, generateBundleModule, OUTPUT } from '../scripts/build-validator.mjs';
import { renderGuide } from '../src/guide';
import { parseJsonc } from '../src/jsonc';
import { renderPlatformJson } from '../src/managed';
import { RULES } from '../src/rules';
import { type FileEntry, validate } from '../src/validate';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir = join(repoRoot, 'fixtures/contract-app');

/** The fixture's committed files plus the managed platform.json, as a repo would contain them. */
function fixtureFiles(): Map<string, FileEntry> {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.'], {
    cwd: fixtureDir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const files = new Map<string, FileEntry>(paths.map((path) => [path, readFileSync(join(fixtureDir, path), 'utf8')]));
  files.set('platform.json', renderPlatformJson({ slug: 'fixture', apiOrigin: 'https://api.example' }));
  return files;
}

const withChanges = (changes: Record<string, FileEntry | null>) => {
  const files = fixtureFiles();
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
  return files;
};
const editJson = (path: string, edit: (json: Record<string, unknown>) => void) => {
  const files = fixtureFiles();
  const json = parseJsonc(files.get(path) as string) as Record<string, unknown>;
  edit(json);
  return JSON.stringify(json);
};
const rulesOf = (files: Map<string, FileEntry>) => validate(files).map((v) => v.rule);

describe('fixture contract app (CON-5)', () => {
  it('passes the validator with no violations (CON-5.1)', () => {
    expect(validate(fixtureFiles())).toEqual([]);
  });

  it('builds with vite build into dist/client and dist/app (CON-5.1)', () => {
    execFileSync('pnpm', ['run', 'build'], { cwd: fixtureDir, stdio: 'pipe' });
    expect(existsSync(join(fixtureDir, 'dist/client/index.html'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'dist/app/wrangler.json'))).toBe(true);
  }, 120_000);

  it('is never imported by production code (CON-5.2)', () => {
    const hits = spawnSync('grep', ['-rl', '--include=*.ts', 'fixtures/', 'apps', 'packages'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .filter((path) => path && !path.includes('/test/') && !path.includes('node_modules'));
    expect(hits).toEqual([]);
  });
});

describe('validate — structure (CON-2)', () => {
  it.each([
    ['CON-R01', withChanges({ 'src/web/main.tsx': null })],
    ['CON-R02', withChanges({ 'package.json': editJson('package.json', (p) => delete p.type) })],
    ['CON-R02', withChanges({ 'package.json': '{ not json' })],
    [
      'CON-R03',
      withChanges({
        'package.json': editJson('package.json', (p) => ((p.scripts as Record<string, string>).build = 'vite')),
      }),
    ],
    [
      'CON-R04',
      withChanges({
        'package.json': editJson('package.json', (p) => ((p.dependencies as Record<string, string>).react = '^19.2.0')),
      }),
    ],
    [
      'CON-R04',
      withChanges({
        'package.json': editJson('package.json', (p) => ((p.dependencies as Record<string, string>).hono = 'latest')),
      }),
    ],
    [
      'CON-R04',
      withChanges({
        'package.json': editJson('package.json', (p) => delete (p.devDependencies as Record<string, string>).vite),
      }),
    ],
    ['CON-R05', withChanges({ 'wrangler.jsonc': '{ "name": ' })],
    ['CON-R06', withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.name = 'my-app')) })],
    [
      'CON-R07',
      withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.compatibility_date = '2030-01-01')) }),
    ],
    [
      'CON-R08',
      withChanges({
        'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.assets = { not_found_handling: '404-page' })),
      }),
    ],
    ['CON-R09', withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.d1_databases = [])) })],
    [
      'CON-R10',
      withChanges({
        'wrangler.jsonc': editJson('wrangler.jsonc', (w) => ((w.assets as Record<string, unknown>).binding = 'ASSETS')),
      }),
    ],
    ['CON-R13', withChanges({ 'migrations/init.sql': 'SELECT 1;' })],
    ['CON-R13', withChanges({ 'migrations/0001_other.sql': 'SELECT 1;' })],
    ['CON-R16', withChanges({ 'index.html': '<div id="root"></div>' })],
    ['CON-R18', withChanges({ 'vite.config.ts': 'export default {}' })],
  ])('%s', (rule, files) => {
    expect(rulesOf(files)).toContain(rule);
  });

  it('accepts ranges at or above the minimum and JSONC comments/trailing commas', () => {
    const pkg = editJson('package.json', (p) => ((p.dependencies as Record<string, string>).react = '^19.3.0'));
    const wrangler = (fixtureFiles().get('wrangler.jsonc') as string).replace(
      '"compatibility_flags": ["nodejs_compat"],',
      '/* block */ "compatibility_flags": ["nodejs_compat",], // line comment\n',
    );
    expect(wrangler).toContain('// line comment');
    expect(rulesOf(withChanges({ 'package.json': pkg, 'wrangler.jsonc': wrangler }))).toEqual([]);
  });

  it('reports every violation with rule, path, message and fix in one run (CON-4.2, CON-4.3)', () => {
    const violations = validate(withChanges({ 'src/web/main.tsx': null, 'index.html': '<p>', 'wrangler.toml': 'x' }));
    expect(violations.map((v) => v.rule).sort()).toEqual(['CON-R01', 'CON-R14', 'CON-R16']);
    for (const v of violations) {
      expect(v.path).toBeTruthy();
      expect(v.message).toBeTruthy();
      expect(v.fix).toBeTruthy();
      expect(v.fix).not.toContain('{{');
    }
  });

  it('every rule has an ID and a fix', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const rule of RULES) expect(rule.fix.length).toBeGreaterThan(0);
  });
});

describe('validate — forbidden content (CON-3, CON-4.6)', () => {
  it.each([
    'wrangler.toml',
    'wrangler.json',
    'node_modules/',
    'dist/',
    '.dev.vars',
    '.env',
    '.env.local',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    'sub/.env',
  ])('rejects %s (CON-R14)', (path) => expect(rulesOf(withChanges({ [path]: 'x' }))).toContain('CON-R14'));

  it.each(['routes', 'kv_namespaces', 'durable_objects', 'env', 'triggers', 'services', 'limits', 'r2_buckets'])(
    'rejects wrangler key %s (CON-R11)',
    (key) => {
      expect(rulesOf(withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w[key] = [])) }))).toContain(
        'CON-R11',
      );
    },
  );

  it('checks vars are strings and not reserved names (CON-R12, CON-R10)', () => {
    expect(
      rulesOf(withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.vars = { N: 1 })) })),
    ).toContain('CON-R12');
    expect(
      rulesOf(withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.vars = { EMAIL: 'x' })) })),
    ).toContain('CON-R10');
    expect(
      rulesOf(withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.vars = { FILES: 'x' })) })),
    ).toContain('CON-R10');
    expect(
      rulesOf(withChanges({ 'wrangler.jsonc': editJson('wrangler.jsonc', (w) => (w.vars = { GREETING: 'hi' })) })),
    ).toEqual([]);
  });

  it('names the alternative for denylisted packages (CON-R15)', () => {
    const violations = validate(
      withChanges({
        'package.json': editJson(
          'package.json',
          (p) => ((p.dependencies as Record<string, string>)['@nestjs/core'] = '10.0.0'),
        ),
      }),
    );
    expect(violations.find((v) => v.rule === 'CON-R15')?.fix).toContain('hono');
  });

  it('rejects unsupported or missing contract versions (CON-R17)', () => {
    expect(rulesOf(withChanges({ 'platform.json': '{"contract_version":"99"}' }))).toContain('CON-R17');
    expect(rulesOf(withChanges({ 'platform.json': null }))).toContain('CON-R17');
  });
});

describe('reference files in the guide (CON-1.4)', () => {
  it('the wrangler.jsonc and vite.config.ts shown in the contract pass the validator', () => {
    const contract = renderGuide('contract', { appsDomain: 'apps.example' });
    const wrangler = /```jsonc\n([\s\S]*?)```/.exec(contract)?.[1] as string;
    const vite = /```ts\n(import \{ defineConfig \}[\s\S]*?)```/.exec(contract)?.[1] as string;
    expect(rulesOf(withChanges({ 'wrangler.jsonc': wrangler, 'vite.config.ts': vite }))).toEqual([]);
  });
});

describe('validator CLI bundle (CON-4.4)', () => {
  it('the generated bundle module is up to date', async () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(generateBundleModule(await bundleValidator()));
  });

  const runCli = (files: Map<string, FileEntry>) => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'));
    for (const [path, content] of files) {
      if (path.endsWith('/')) {
        mkdirSync(join(dir, path), { recursive: true });
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof content === 'string' ? content : '');
    }
    const script = join(dir, '..', `validator-${Date.now()}.mjs`);
    const bundle = /export const VALIDATOR_BUNDLE = (".*");/s.exec(readFileSync(OUTPUT, 'utf8'))?.[1] as string;
    writeFileSync(script, JSON.parse(bundle) as string);
    return spawnSync('node', [script, dir], { encoding: 'utf8' });
  };

  it('exits 0 with an empty list for a valid app', () => {
    const result = runCli(fixtureFiles());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ violations: [] });
  });

  it('exits 1 and prints violations as JSON', () => {
    const result = runCli(withChanges({ 'src/api/index.ts': null, 'node_modules/': '' }));
    expect(result.status).toBe(1);
    const { violations } = JSON.parse(result.stdout) as { violations: { rule: string }[] };
    expect(violations.map((v) => v.rule).sort()).toEqual(['CON-R01', 'CON-R14']);
  });
});
