/** Contract rules (spec 06 design) — the single source for the validator and the guide (CON-1.3). */
export type ContractRule = { id: `CON-R${string}`; rule: string; fix: string };

export const RULES: ContractRule[] = [
  { id: 'CON-R01', rule: 'A required file is missing.', fix: 'Create the file as described in this contract.' },
  {
    id: 'CON-R02',
    rule: '`package.json` must be valid JSON with `"type": "module"` and `"private": true`.',
    fix: 'Add `"type": "module"` and `"private": true`.',
  },
  { id: 'CON-R03', rule: '`scripts.build` must be exactly `vite build`.', fix: 'Set `"build": "vite build"`.' },
  {
    id: 'CON-R04',
    rule: 'A required dependency is missing, below its minimum version, or not pinned to a version.',
    fix: 'Add the package with at least the minimum version (e.g. `"react": "^19.3.0"`); never use `*` or `latest`.',
  },
  {
    id: 'CON-R05',
    rule: '`wrangler.jsonc` must parse as JSONC.',
    fix: 'Fix the syntax — comments and trailing commas are fine; keys and strings need double quotes.',
  },
  {
    id: 'CON-R06',
    rule: '`wrangler.jsonc` must have `"name": "app"` and `"main": "src/api/index.ts"`.',
    fix: 'Copy those two values from the reference `wrangler.jsonc`.',
  },
  {
    id: 'CON-R07',
    rule: '`compatibility_date` must be within the supported window.',
    fix: 'Use a date between {{COMPATIBILITY_DATE_MIN}} and {{COMPATIBILITY_DATE_MAX}}.',
  },
  {
    id: 'CON-R08',
    rule: '`assets` must set `not_found_handling: "single-page-application"` and `run_worker_first` including `"/api/*"`.',
    fix: 'Copy the `assets` block from the reference `wrangler.jsonc`.',
  },
  {
    id: 'CON-R09',
    rule: 'Exactly one D1 database binding, named `DB`.',
    fix: 'Keep a single `d1_databases` entry with `"binding": "DB"`.',
  },
  {
    id: 'CON-R10',
    rule: '`EMAIL` and `ASSETS` are injected by the platform and must not be declared as bindings.',
    fix: 'Remove them from `wrangler.jsonc`; use `env.EMAIL` / assets as documented.',
  },
  {
    id: 'CON-R11',
    rule: '`wrangler.jsonc` uses a key the platform does not support yet.',
    fix: 'Remove the key; the feature is not available in this contract version.',
  },
  {
    id: 'CON-R12',
    rule: '`vars` must be string values and must not reuse reserved names (`DB`, `ASSETS`, `EMAIL`) or secret names.',
    fix: 'Use string values and rename the variable.',
  },
  {
    id: 'CON-R13',
    rule: 'Migration files must be named `NNNN_description.sql` with unique numbers.',
    fix: 'Rename the file, e.g. `0002_add_todos.sql`.',
  },
  {
    id: 'CON-R14',
    rule: 'A forbidden file is present (`wrangler.toml`, `wrangler.json`, `node_modules/`, `dist/`, `.dev.vars`, `.env*`, non-npm lockfiles).',
    fix: 'Delete it with `write_files` (`op: "delete"`).',
  },
  { id: 'CON-R15', rule: 'A dependency on the denylist is used.', fix: 'Replace it with the listed alternative.' },
  {
    id: 'CON-R16',
    rule: '`index.html` must load `/src/web/main.tsx` as a module script.',
    fix: 'Add `<script type="module" src="/src/web/main.tsx"></script>` to `index.html`.',
  },
  {
    id: 'CON-R17',
    rule: '`platform.json` declares an unsupported `contract_version`.',
    fix: 'Do not edit `platform.json`; call `redeploy`, or tell the user to contact support.',
  },
  {
    id: 'CON-R18',
    rule: '`vite.config.ts` must use the `cloudflare()` and `react()` plugins.',
    fix: 'Use the reference `vite.config.ts`.',
  },
];
