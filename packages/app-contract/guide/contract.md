# App contract (version {{CONTRACT_VERSION}})

One Cloudflare Worker serves both a **Hono** API under `/api/*` and a **React** single-page app (built with **Vite**) as static assets. Data lives in a **D1** (SQLite) database, optionally through **Drizzle**. There is no other runtime: no Node server, no SSR framework, no filesystem.

## Required files

```
package.json
wrangler.jsonc
vite.config.ts
tsconfig.json
index.html
src/api/index.ts      # default-exports the Hono app; API routes under /api/
src/api/env.ts        # the Env interface (bindings, vars, secrets)
src/web/main.tsx      # React entry: createRoot(document.getElementById('root')!).render(<App />)
migrations/           # optional: NNNN_description.sql files (see the database topic)
```

Platform-managed (never edit): `platform.json`, `.github/workflows/deploy.yml`.

## `wrangler.jsonc` — write exactly this

```jsonc
// wrangler.jsonc — the platform overrides name, database_name and database_id at deploy time
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "app",
  "main": "src/api/index.ts",
  "compatibility_date": "{{COMPATIBILITY_DATE_MAX}}",
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

You may add a `"vars"` object with **string** values. Nothing else: no other bindings, `routes`, `triggers`, `env`, `durable_objects`, `services` or `limits`.

## `vite.config.ts` — write exactly this

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({ plugins: [react(), cloudflare()] });
```

## `package.json`
- `"type": "module"`, `"private": true`, and `"scripts": { "build": "vite build" }`. An optional `"typecheck": "tsc --noEmit"` script runs during the build.
- npm only: commit `package-lock.json` or no lockfile at all.
- Required dependencies (at least these versions):

{{REQUIRED_DEPENDENCIES}}

- `drizzle-orm` is the only supported ORM (optional).

## `index.html`
At the repo root, with `<div id="root"></div>` and `<script type="module" src="/src/web/main.tsx"></script>`.

## API (`src/api/index.ts`)
Default-export a Hono app (it has a `fetch` handler). Put every API route under `/api/`; everything else is served by the SPA.

```ts
import { Hono } from 'hono';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();
app.get('/api/health', (c) => c.json({ ok: true }));
export default app;
```

## Bindings (`src/api/env.ts`)
The platform provides exactly these at runtime; declare them in your `Env` interface:
- `DB: D1Database` — your app's database.
- `FILES: R2Bucket` — your app's file storage (see the `storage` topic; injected, don't declare it in `wrangler.jsonc`).
- `ASSETS: Fetcher` — the built SPA (injected; don't declare it in `wrangler.jsonc`).
- `EMAIL` — send email (see the `email` topic; injected, don't declare it in `wrangler.jsonc`).
- Your string `vars` and your secrets (see the `secrets` topic).

## Runtime rules
- Workers runtime, not Node: no `fs`, no child processes, no native addons, no listening on ports.
- Each request may use up to {{APP_CPU_MS_PER_REQUEST}} ms of CPU and {{APP_SUBREQUESTS_PER_REQUEST}} outbound requests.
- Hash passwords with WebCrypto (PBKDF2) or `bcryptjs`, never native `bcrypt`.

## Cookies

Every app's cookies are private to it; other apps can't read or plant them.
- Set cookies from the API (`Set-Cookie` / Hono's `setCookie`) as usual; they come back to your API under the same name. The platform stores them as `__Host-<name>` (host-only, `Secure`, `Path=/`), so `Domain` and `Path` attributes are ignored.
- Browser JavaScript sees server-set cookies as `__Host-<name>` in `document.cookie`. A cookie set from browser JavaScript only reaches your API if it's named `__Host-<name>` and has `Secure; Path=/`. Prefer `HttpOnly` cookies set by the API.
- A request coming from a link on another app arrives without cookies, as if from another website.

## Rules checked before every build

{{RULES}}

## Packages you must not use

{{DENYLIST}}
