# 07 — Source Repositories: Tasks

Depends on: 00, 03 (apps table, `resolveApp`, quota service), 04 (tool framework), 06 (managed files).

- [ ] **1. GitHub App setup (dev + prod)** — create Apps with the permission table, install on `GITHUB_ORG`, store secrets; document in `docs/runbook.md`.
  Satisfies: SRC-4.1 (setup)
  Tests: manual — token exchange works in dev.

- [ ] **2. `GitHubClient` real implementation + fake**
  JWT signing (WebCrypto RS256), scoped installation tokens + cache, error mapping.
  Satisfies: SRC-4.1, SRC-4.2, SRC-4.3
  Tests: JWT claims/signature verified with a test key; token cache hit/miss/expiry (fake clock); 502/secondary-rate-limit → `UPSTREAM_ERROR` with `retry_after_seconds`; fake passes a shared contract test suite with the real client's recorded responses.

- [ ] **3. Repo provisioning step** (plugs into `ProvisionApp`)
  Satisfies: SRC-1.1, SRC-1.2, SRC-1.3, SRC-1.4, APP-2.7
  Tests (fake): creates private repo with correct settings; empty-repo bootstrap via contents API; both commits contain `[skip ci]`; only managed files committed; reuse when `platform.json.app` matches; `CONFLICT` otherwise; repo id saved.

- [ ] **4. Path/size validation module**
  Satisfies: SRC-2.3, SRC-2.4, SRC-2.5
  Tests: table of bad paths; protected paths incl. `.github/foo`, `platform.json`; size boundaries per limit; all checks before any I/O (fake records no calls).

- [ ] **5. `write_files` tool**
  Satisfies: SRC-2.1, SRC-2.2, SRC-2.6, SRC-2.7, SRC-2.8, SRC-2.9, SRC-2.10, SRC-2.11, SRC-2.12, SRC-2.13
  Tests: mixed upsert/delete → one commit; base64 content; conflict with base sha; single auto-retry on race then conflict; quota consumed only when deploying and refunded on no-change; `[skip ci]` when `deploy:false`; trailers present; deployment row created `queued` with commit sha; delete of missing path in `skipped`.

- [ ] **6. `list_files`, `read_file` tools**
  Satisfies: SRC-3.1, SRC-3.2, SRC-3.3, SRC-3.4, SRC-3.5, SRC-1.5
  Tests: prefix filter; managed flag; binary → base64; chunking on line boundary with `next_offset`; bad ref/path → `NOT_FOUND`; outputs contain no GitHub URLs/ids.

- [ ] **7. E2E on dev** (spec 12)
  Flows: `F-SRC-1`, `F-SRC-2`.
  Satisfies: E2E-3.3
