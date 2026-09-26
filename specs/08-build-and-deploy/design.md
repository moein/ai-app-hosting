# 08 — Build & Deploy: Design

## Sequence

```
AI ─write_files─▶ api ──commit──▶ GitHub (main)        api: INSERT deployment (queued)
                                    │ push event
                                    ▼
                         Actions runner (deploy.yml)
                          ├─ POST /v1/builds/start ─────────────▶ api: queued → building (+cancel others)
                          ├─ validator.mjs (spec 06)
                          ├─ npm install / typecheck / build
                          ├─ tar dist migrations manifest.json
                          └─ PUT /v1/builds/:dep/artifact ──────▶ api: R2 put → deploying → DeployApp workflow
                             (on failure: POST /v1/builds/:dep/fail)                       │
                                                                                          ▼
                                            DeployApp: parse → migrations (D1 REST) → assets upload → script upload
                                                       → succeeded + apps.live_deployment_id + KV route 'live'
AI ─get_deployment(wait_seconds)─▶ api (polls D1)
```

## Data model

```sql
CREATE TABLE deployments (
  id                    TEXT PRIMARY KEY,                -- dep_…
  app_id                TEXT NOT NULL REFERENCES apps(id),
  org_id                TEXT NOT NULL REFERENCES organizations(id),
  trigger               TEXT NOT NULL,                   -- 'push' | 'redeploy' | 'rollback'
  commit_sha            TEXT NOT NULL,
  source_deployment_id  TEXT REFERENCES deployments(id), -- rollback only
  status                TEXT NOT NULL,                   -- 'queued'|'building'|'deploying'|'succeeded'|'failed'|'cancelled'
  error_code            TEXT,
  error_details         TEXT,                            -- JSON ≤ 20 KB: { step, violations? , log_tail? , message? }
  run_id                INTEGER, run_attempt INTEGER, job_id INTEGER,
  artifact_key          TEXT,
  artifact_bytes        INTEGER,
  created_by            TEXT REFERENCES users(id),
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,                         -- building
  build_finished_at     INTEGER,                         -- artifact received
  finished_at           INTEGER
);
CREATE INDEX deployments_app_created ON deployments (app_id, created_at DESC);
CREATE INDEX deployments_app_commit ON deployments (app_id, commit_sha);
CREATE INDEX deployments_status_created ON deployments (status, created_at);
```

Public status (DEP-3.1) is computed: `succeeded` → `live` if `apps.live_deployment_id = id`, else `superseded`.

Transitions (enforced with conditional `UPDATE … WHERE status IN (…)`):

```
queued ──start──▶ building ──artifact──▶ deploying ──ok──▶ succeeded
  │                  │                      │
  └──────────────────┴──fail / timeout──────┴──▶ failed
queued|building ──superseded by newer start / app deleted──▶ cancelled
rollback: created directly as deploying
```

## Managed workflow (`packages/app-contract/managed/deploy.yml`, sketch)

```yaml
name: deploy
on:
  push: { branches: [main] }
  workflow_dispatch:
    inputs: { deployment_id: { required: true, type: string } }
concurrency: { group: deploy, cancel-in-progress: true }
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      API: PLATFORM_API_ORIGIN
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 24, cache: npm, cache-dependency-path: package.json }
      - name: start
        run: |                                      # (inline shell) OIDC token from
          …                                         # $ACTIONS_ID_TOKEN_REQUEST_URL&audience=$API → POST /v1/builds/start → echo DEP_ID >> $GITHUB_ENV
      - name: validate
        run: |
          V=$(jq -r .contract_version platform.json)
          curl -fsSL "$API/v1/contract/validator/$V.mjs" -o /tmp/validator.mjs
          node /tmp/validator.mjs . > /tmp/violations.json
      - name: install
        run: '[ -f package-lock.json ] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund'
      - name: typecheck
        run: 'jq -e .scripts.typecheck package.json >/dev/null && npm run typecheck || true'   # only if present
      - name: build
        run: npm run build
      - name: package
        run: |
          jq -n --arg c "$GITHUB_SHA" --arg v "$(jq -r .contract_version platform.json)" --arg t "$(date -u +%FT%TZ)" \
            '{commit_sha:$c, contract_version:$v, built_at:$t}' > manifest.json
          mkdir -p migrations && tar czf /tmp/artifact.tgz dist migrations manifest.json
      - name: upload
        run: …   # (inline shell) fresh OIDC token → PUT $API/v1/builds/$DEP_ID/artifact --data-binary @/tmp/artifact.tgz
      - name: report failure
        if: failure()
        run: …   # (inline shell) fresh OIDC token → POST $API/v1/builds/$DEP_ID/fail { step, violations | log_tail }
```

Each step pipes output through `tee /tmp/logs/<step>.log` so the failure step can send the tail. Action versions are pinned by commit SHA. The callback logic is inlined in the YAML (no extra managed files).

## Build callback API (`apps/api`, Hono)

Two route groups (00 design "HTTP routing"):
- `buildsRoutes` (`src/http/routes/builds.ts`), mounted at `/v1/builds`, with `oidcAuth()` attached inside the group — every build route requires `Authorization: Bearer <GitHub OIDC JWT>`; the verified claims are put in `c.var.oidc`.
- `contractRoutes` (`src/http/routes/contract.ts`), mounted at `/v1/contract`, public, with `immutableCache()` attached inside the group.

| Method + path | Body | Response |
|---|---|---|
| `POST /v1/builds/start` | `{ commit_sha, run_id, run_attempt, job_id?, deployment_id? }` | `200 { deployment_id }` |
| `POST /v1/builds/:dep/fail` | `{ step, violations?, log_tail? }` | `204` |
| `PUT /v1/builds/:dep/artifact` | `application/gzip` body (≤ `MAX_ARTIFACT_BYTES`) | `202` |
| `GET /v1/contract/validator/:version.mjs` | — (public) | JS (spec 06) |

### OIDC verification

- JWKS: `https://token.actions.githubusercontent.com/.well-known/jwks`, cached 1 h (refetch on unknown `kid`); verify with `jose`.
- Claims: `iss = https://token.actions.githubusercontent.com`, `aud = PLATFORM_API_ORIGIN`, `repository_owner = GITHUB_ORG`, `repository_id = apps.repo_id` (app looked up by `repository_id`), `ref = refs/heads/main`, `workflow_ref = GITHUB_ORG/<repo>/.github/workflows/deploy.yml@refs/heads/main`, `event_name ∈ {push, workflow_dispatch}`.
- Start: if no matching deployment exists (e.g. a push not from `write_files`), create one with trigger `push` (and consume quota; if exhausted respond 429 and the workflow reports failure).

## `DeployApp` Workflow

Params: `{ deploymentId, artifactKey, skipMigrations }`.

```
step "load"      : R2 get → gunzip (DecompressionStream) → untar (small in-house tar reader)
                   → verify dist/app/wrangler.json (generated), main module (must contain a default export — CON-2.7), dist/client/  → else BUILD_FAILED
step "migrate"   : unless skipMigrations:
                   D1 REST query on app DB:
                     CREATE TABLE IF NOT EXISTS _platform_migrations (name TEXT PRIMARY KEY, sha256 TEXT, applied_at INTEGER)
                   for file in sorted(migrations/*.sql):
                     applied? hash equal → skip; hash differs → MIGRATION_FAILED
                     else execute file, INSERT record                        → error → MIGRATION_FAILED
step "assets"    : manifest {"/path": {hash, size}} → assets-upload-session (dispatch namespace script)
                   → upload missing buckets → completion JWT
step "script"    : multipart upload to dispatch namespace `apps-<env>` script `script_name`:
                   metadata { main_module, compatibility_date, compatibility_flags (from generated wrangler.json,
                              date clamped to supported window), bindings: spec 09 table,
                              keep_bindings: ["secret_text"], assets: { jwt, config },
                              tail_consumers: [{ service: "tail-<env>" }], tags: [app_id, org_id] }
step "activate"  : D1 batch: deployment succeeded + finished_at; apps.live_deployment_id = id
                   KV APP_ROUTES <slug> = { appId, scriptName, state: 'live' }
                   metrics deployment_finished
on failure       : deployment failed (MIGRATION_FAILED | BUILD_FAILED | DEPLOY_FAILED); metrics
```

Workers for Platforms deploys are atomic per script upload, so the previous version serves until the new upload succeeds.

## MCP tool contracts

```ts
type DeploymentView = {
  id: string; status: 'queued'|'building'|'deploying'|'live'|'superseded'|'failed'|'cancelled';
  trigger: 'push'|'redeploy'|'rollback'; commit_sha: string; commit_message: string | null;
  source_deployment: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  url: string | null;                                        // when live
  error: { code: string; message: string; step?: string;
           violations?: Violation[]; build_log_excerpt?: string; errors?: BuildError[] } | null; // spec 10
  next_step: string;
};

get_deployment    in { app; deployment?: string; wait_seconds?: 0..25 }   out DeploymentView
list_deployments  in { app; limit?: 1..50; before?: string }             out { deployments: DeploymentView[]; next_cursor: string | null }
redeploy          in { app }                                             out DeploymentView
rollback          in { app; deployment: string }                         out DeploymentView & { warning: string }
```

`next_step` by status: queued/building/deploying → "Call get_deployment again with wait_seconds=25."; live → "Tell the user their app is live at <url>."; failed → "Fix the problems in error (see hint), then write_files again."; cancelled → "A newer deployment replaced this one; check the latest with get_deployment."

## Limits

| Constant | Value |
|---|---|
| `MAX_ARTIFACT_BYTES` | 50_000_000 |
| `MAX_WORKER_BUNDLE_BYTES` | 10_000_000 (compressed) |
| `MAX_ASSET_FILES` | 5_000 |
| `MAX_ASSET_FILE_BYTES` | 25 MiB |
| `DEPLOY_QUEUED_TIMEOUT_MS` | 15 min |
| `DEPLOY_BUILDING_TIMEOUT_MS` | 20 min |
| `ARTIFACTS_RETAINED_PER_APP` | 20 |
| `GET_DEPLOYMENT_MAX_WAIT_S` | 25 |

## Crons (`apps/api` `scheduled`)

- every 5 min: stale deployment sweeper (DEP-2.12).
- daily: artifact retention cleanup.

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `BUILD_FAILED` | false | The build failed at `details.step`. Read `errors`/`build_log_excerpt`, fix the code, write_files again. |
| `MIGRATION_FAILED` | false | A database migration failed (`details.file`). Never edit an applied migration — add a new numbered one. Fix and write again. |
| `DEPLOY_FAILED` | true | Publishing to the edge failed. Call `redeploy`. |
| `DEPLOYMENT_NOT_ROLLBACKABLE` | false | Only previously live (`superseded`) deployments can be restored. Use list_deployments to pick one. |

## Security notes

- Untrusted code (AI-written + npm deps) runs only in GitHub-hosted runners. A malicious dependency could mint an OIDC token for *this* repo and upload an artifact — affecting only this app, which the user already controls.
- The platform ignores all bindings in the artifact's generated `wrangler.json` (plain JSON emitted by `@cloudflare/vite-plugin` from the app's `wrangler.jsonc`) except `DB` name and string `vars`; bindings are always built server-side (DEP-2.9).
- `workflow_ref` pinning stops a modified workflow elsewhere from authenticating; managed paths can't be changed via `write_files` (SRC-2.4).

## Open questions

1. GitHub Actions minutes cost for private repos at scale; alternatives: public repos, self-hosted runners, or Cloudflare Containers builds.
2. Should `rollback` also move `main` back (revert commit) so the next deploy doesn't reintroduce the bug?
3. Clamp vs. reject app `compatibility_date` outside the window at deploy time (validator already rejects).
