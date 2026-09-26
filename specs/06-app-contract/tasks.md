# 06 — App Contract: Tasks

Depends on: 00.

- [ ] **1. Guide content (`packages/app-contract/guide/*.md`)**
  Write all topics; `contract.md` generated sections from `rules.ts` + exact `wrangler.jsonc` / `vite.config.ts` reference text; explicit "the platform provides no templates — you write every file except managed ones".
  Satisfies: CON-1.2, CON-1.3, CON-1.4, MCP-2.4
  Tests: every rule ID in `rules.ts` appears in `contract.md`; reference `wrangler.jsonc` in the guide passes the validator (parse from Markdown code block).

- [ ] **2. `rules.ts`, `version.ts`, `denylist.ts`**
  Satisfies: CON-3.2 (data), CON-4.6 (data)
  Tests: rule IDs unique and all have `fix`.

- [ ] **3. `validate()` — structure rules** (R01–R10, R13, R16, R18)
  Satisfies: CON-2.1, CON-2.2, CON-2.3, CON-2.4, CON-2.5, CON-2.6, CON-2.8, CON-4.1, CON-4.2, CON-4.3
  Tests: table-driven per rule (one failing fixture each, asserting rule/path/fix); multi-violation input returns all; version comparisons (`^19.2.0` fails, `^19.3.0` passes, `latest` fails).

- [ ] **4. `validate()` — forbidden content** (R11, R12, R14, R15, R17)
  Satisfies: CON-3.1, CON-3.2, CON-3.3, CON-3.4, CON-4.6
  Tests: each forbidden file; each unsupported key; denylisted dep message names alternative; bad contract version.

- [ ] **5. CLI + bundle + serving endpoint**
  `cli.ts` → `dist/validator.mjs` (single file, zero deps); `GET /v1/contract/validator/<version>.mjs` in `apps/api`.
  Satisfies: CON-4.4
  Tests: CLI exit codes and JSON output on fixture dirs; endpoint returns JS with immutable cache headers; unknown version → 404.

- [ ] **6. `fixtures/contract-app`**
  Minimal app: `/api/health` (Hono) reading `DB`, React page calling it, one migration.
  Satisfies: CON-5.1, CON-5.2
  Tests: validator returns `[]`; `vite build` produces `dist/client` and `dist/app`; a repo-wide test asserts no production code imports from `fixtures/`.

- [ ] **7. Managed files**
  `managed/platform.json.ts`; `deploy.yml` content owned by spec 08 task 2.
  Satisfies: CON-1.1
  Tests: managed file list is exactly `.github/workflows/deploy.yml`, `platform.json`.

- [ ] **8. E2E on dev** (spec 12)
  Flows: `F-DEP-2` (contract violations reported); `F-DEP-1` (contract-compliant app goes live).
  Satisfies: E2E-3.3
