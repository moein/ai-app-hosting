# 06 — App Contract: Design

## Package `packages/app-contract`

```
packages/app-contract/
├── src/version.ts             # CONTRACT_VERSION = "1"; SUPPORTED_VERSIONS; compatibility-date window; required deps
├── src/rules.ts               # rule table (id, description, fix) — single source for validator + guide
├── validate.ts                # validate(files: Map<string, string | { bytes: number }>) → Violation[]
├── cli.ts                     # bundled to dist/validator.mjs (no deps), `node validator.mjs <dir>`
├── src/denylist.ts            # package → { reason, alternative }
├── src/guide.ts               # renderGuide(topic, { appsDomain }) — fills placeholders, joins topics for "all"
├── src/guide-sources.generated.ts   # generated from guide/*.md by scripts/build-guide.mjs (committed; a test fails if stale)
├── guide/
│   ├── workflow.md  contract.md  database.md  email.md  secrets.md  limits.md  troubleshooting.md
└── managed/
    ├── deploy.yml             # spec 08
    └── platform.json.ts       # (slug, env) → platform.json content
```

The API serves the bundled validator at `GET /v1/contract/validator/<version>.mjs` (immutable, cached); the managed workflow downloads it (spec 08).

## App layout (contract v1)

```
/
├── platform.json            # MANAGED — do not edit
├── .github/workflows/deploy.yml  # MANAGED — do not edit
├── package.json
├── wrangler.jsonc
├── vite.config.ts
├── tsconfig.json
├── index.html
├── migrations/
│   └── 0001_init.sql
└── src/
    ├── api/
    │   ├── index.ts         # export default app (Hono), routes under /api/*
    │   └── env.ts           # interface Env { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher; EMAIL: AppEmail }
    └── web/
        ├── main.tsx         # createRoot(document.getElementById('root')!).render(<App />)
        └── …                # React components, CSS
```

### Required `wrangler.jsonc` (exact reference text in the guide)

```jsonc
// wrangler.jsonc — the platform overrides name, database_name and database_id at deploy time
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "app",
  "main": "src/api/index.ts",
  "compatibility_date": "2026-08-22",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "local", "migrations_dir": "migrations" }
  ]
}
```

At deploy time the platform ignores `name`, `database_name`, `database_id` and injects the real script name, the app's D1 UUID, `FILES` (spec 15), `ASSETS`, `EMAIL`, secrets and the tail consumer (spec 08/09). Values above make `vite build` work in CI without Cloudflare credentials.

### Required `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({ plugins: [react(), cloudflare()] });
```

Build output (from `@cloudflare/vite-plugin`): `dist/client/` (static assets) and `dist/app/` (Worker modules + a plain-JSON `wrangler.json` that the plugin generates — build output, not a config file anyone writes; it lives only in the artifact, never in the repo).

### `platform.json` (managed)

```json
{ "contract_version": "1", "app": "<slug>", "api": "PLATFORM_API_ORIGIN" }
```

## Rules (`rules.ts`)

| ID | Rule | Fix (abridged) |
|---|---|---|
| `CON-R01` | Required file missing (CON-2.1) | Create `<path>` as described in the contract. |
| `CON-R02` | `package.json` invalid JSON / missing `type: module` / `private: true` | … |
| `CON-R03` | `scripts.build` must be `vite build` | Set `"build": "vite build"`. |
| `CON-R04` | Required dependency missing or below minimum version (CON-2.3) | Add `"<pkg>": "<min>"` or newer. |
| `CON-R05` | `wrangler.jsonc` can't be parsed as JSONC | Fix the syntax (comments and trailing commas are fine; keys and strings must use double quotes). |
| `CON-R06` | `wrangler.jsonc` `name`/`main` wrong | Use `"name": "app"`, `"main": "src/api/index.ts"`. |
| `CON-R07` | `compatibility_date` outside supported window | Use a date between `<min>` and `<max>`. |
| `CON-R08` | `assets` config wrong | Copy the `assets` block from the contract. |
| `CON-R09` | D1 binding missing / not named `DB` / more than one | Exactly one `d1_databases` entry with `binding: "DB"`. |
| `CON-R10` | Reserved binding declared (`EMAIL`, `ASSETS`, `FILES` as binding) | Remove it; the platform injects it. |
| `CON-R11` | Unsupported `wrangler.jsonc` key (CON-3.3) | Remove `<key>`; `<feature>` isn't available yet. |
| `CON-R12` | Invalid `vars` (non-string or reserved name) | Use string values; rename `<name>`. |
| `CON-R13` | Migration filename invalid or duplicate prefix | Rename to `NNNN_description.sql`. |
| `CON-R14` | Forbidden file present (CON-3.1) | Delete `<path>` (write_files with op `delete`). |
| `CON-R15` | Denylisted dependency | Replace `<pkg>` with `<alternative>`. |
| `CON-R16` | `index.html` doesn't load `/src/web/main.tsx` | Add `<script type="module" src="/src/web/main.tsx"></script>`. |
| `CON-R17` | Unsupported `contract_version` | Do not edit `platform.json`; call `redeploy` or contact support. |
| `CON-R18` | `vite.config.ts` missing `cloudflare()` or `react()` plugin | Use the contract's `vite.config.ts`. |

`CON-R16` and `CON-R18` are static text checks (regex), not execution. `CON-2.7` (default export with `fetch`) is verified by the build (spec 08) rather than statically.

## Dependency denylist (`denylist.ts`, initial)

| Package(s) | Reason | Alternative |
|---|---|---|
| `express`, `koa`, `fastify`, `@nestjs/*` | Node HTTP servers | `hono` |
| `next`, `@remix-run/*`, `nuxt`, `@sveltejs/kit` | Other frameworks (not in contract v1) | Vite + React + Hono |
| `prisma`, `@prisma/client`, `typeorm`, `sequelize`, `mongoose` | Unsupported ORMs/DBs | `drizzle-orm` with D1 |
| `sqlite3`, `better-sqlite3`, `pg`, `mysql2` | Native/TCP DB drivers | `env.DB` (D1) |
| `bcrypt`, `argon2`, `sharp`, `canvas`, `puppeteer` | Native addons | WebCrypto (PBKDF2), `bcryptjs` |
| `nodemailer` | SMTP | `env.EMAIL.send()` |
| `dotenv` | Env files | `set_secret` + `env` |

## Validator types

```ts
type Violation = { rule: `CON-R${string}`; path: string; message: string; fix: string };
type FileEntry = string /* text content */ | { bytes: number } /* binary/large: presence only */;
validate(files: Map<string, FileEntry>): Violation[];
```

CLI: walks the directory (ignoring `.git/`), loads text files ≤ 1 MB, runs `validate`, prints `{"violations":[…]}`, exit 1 if any.

`wrangler.jsonc` is parsed with a small in-house JSONC parser (`src/jsonc.ts`: strips `//` and `/* */` comments outside strings and trailing commas, then `JSON.parse`), so the bundled `validator.mjs` has no dependencies. `pnpm -F @repo/app-contract build:validator` bundles `src/cli.ts` with esbuild into `src/validator-bundle.generated.ts` (a string the api serves); a test fails if it is stale.

Version comparison uses a tiny internal semver-min check on the declared range's lowest version (`^19.3.0`, `19.3.0`, `>=19.3.0`, `~19.3.0` supported; `*`/`latest` → violation `CON-R04` "pin a version").

## Error code (added)

| Code | retryable | Hint |
|---|---|---|
| `CONTRACT_VIOLATION` | false | The code breaks the app contract. Fix every item in `details.violations` (each has a `fix`), then write the files again. |

## Open questions

1. Allow `bun`/`pnpm` users? (Current: npm only; `package-lock.json` optional.)
2. Should `write_files` run a subset of static checks immediately (e.g. forbidden files, `wrangler.jsonc` shape) to shorten the feedback loop?
3. Contract v2 candidates: KV, R2, cron triggers, SSR.
