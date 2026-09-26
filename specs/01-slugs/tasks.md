# 01 — Slugs: Tasks

- [x] **1. `validateSlug` + reserved list**
  Implement in `packages/shared/slugs.ts`; export `RESERVED_SLUGS`.
  Satisfies: SLUG-1.1, SLUG-1.2, SLUG-1.3, SLUG-1.4, SLUG-1.5, SLUG-1.6
  Tests: table-driven cases for each reason incl. boundaries (3 and 63 chars valid, 2 and 64 invalid), `xn--abc` → `double_hyphen`, uppercase → `invalid_chars`, every reserved word → `reserved`, rule precedence.

- [x] **2. `slugBase`, `randomSuffix`, `orgNameFromEmail`**
  Satisfies: SLUG-2.1, SLUG-2.2, SLUG-2.3, SLUG-2.4, SLUG-2.7
  Tests: examples table from design.md; diacritics; emoji-only; digit start; 200-char input truncated to ≤ 58 with no trailing hyphen; `+tag` removal; suffix alphabet/length with seeded `Random`.

- [x] **3. `generateSlug` with injected availability**
  Satisfies: SLUG-2.5, SLUG-2.6
  Tests: free base returned unchanged; taken base gets suffix; reserved base gets suffix; 5 consecutive collisions → `INTERNAL`; property test: 1,000 random Unicode names always yield valid slugs.

- [x] **4. Error codes `SLUG_INVALID`, `SLUG_UNAVAILABLE`** in the error catalog.
  Satisfies: SLUG-4.1, SLUG-4.2 (codes only)
  Tests: catalog entries have hints.

- [ ] **5. Unique indexes + insert-retry helper** (after spec 03 task creating tables)
  `insertWithSlug(generate, insert)` retrying on unique violation.
  Satisfies: SLUG-3.1, SLUG-3.2, SLUG-3.3, SLUG-3.4
  Tests (pool-workers, real D1): duplicate insert fails at DB level; two concurrent generated inserts for same name both succeed with different slugs; requested-slug race returns `SLUG_UNAVAILABLE`; deleted app's slug remains taken; no update path for slug exists (schema/API test).

- [ ] **6. `check_slug` MCP tool** (after spec 04 tool framework)
  Satisfies: SLUG-4.3
  Tests: valid+free, valid+taken (with suggestion), invalid (with reason + suggestion).

- [ ] **7. E2E on dev** (spec 12)
  Flows: `F-SLUG-1`, `F-APP-2`.
  Satisfies: E2E-3.3
