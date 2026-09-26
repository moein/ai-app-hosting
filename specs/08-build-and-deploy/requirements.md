# 08 — Build & Deploy: Requirements

Every commit to an app's `main` branch (spec 07) is built by a platform-managed GitHub Actions workflow in the app's repo. The workflow validates the code against the app contract (spec 06), builds it, and uploads the artifact to the platform, authenticating with a GitHub OIDC token. The platform then applies D1 migrations and deploys the Worker into the Workers for Platforms dispatch namespace. No Cloudflare credentials ever exist in app repos.

## Stories & acceptance criteria

### DEP-1 — Build in the app's repository
As the platform, I want builds to run in isolated, disposable CI runners, so that untrusted AI-written code never builds on our infrastructure.

- **DEP-1.1** THE SYSTEM SHALL provide the managed workflow `.github/workflows/deploy.yml` triggered by `push` to `main` and by `workflow_dispatch` with a required `deployment_id` input.
- **DEP-1.2** THE SYSTEM SHALL configure the workflow with `concurrency: { group: deploy, cancel-in-progress: true }`, `permissions: { id-token: write, contents: read }` and a 10-minute job timeout.
- **DEP-1.3** THE SYSTEM SHALL run these steps in order: start callback → download validator for the repo's `contract_version` → validate → install (`npm ci` if `package-lock.json` exists, else `npm install`) → `npm run typecheck` if the script exists → `npm run build` → package artifact → upload artifact.
- **DEP-1.4** WHEN any step fails THE SYSTEM SHALL call the fail callback with the failed step name and either the validator's violations or the last 200 lines (≤ 20 KB) of that step's output.
- **DEP-1.5** THE SYSTEM SHALL authenticate every callback with a freshly requested GitHub OIDC token whose audience is `PLATFORM_API_ORIGIN`.
- **DEP-1.6** THE SYSTEM SHALL NOT place any Cloudflare, AWS or platform credential in app repositories, workflow files or GitHub secrets.
- **DEP-1.7** THE SYSTEM SHALL package the artifact as a gzipped tar containing `dist/`, `migrations/` and `manifest.json` (`commit_sha`, `contract_version`, `built_at`), at most `MAX_ARTIFACT_BYTES`.

### DEP-2 — Accept builds and deploy
As a user, I want my app to go live automatically after the AI changes it, so that I just get a working URL.

- **DEP-2.1** WHEN a build callback arrives THE SYSTEM SHALL verify the OIDC token's signature (GitHub JWKS), `iss`, `aud`, `exp`, and that `repository_id` equals the app's `repo_id`, `ref` is `refs/heads/main`, and `workflow_ref` is the managed workflow on `main`; IF any check fails THEN THE SYSTEM SHALL respond 401 and change nothing.
- **DEP-2.2** WHEN the start callback arrives THE SYSTEM SHALL move the matching deployment (by `deployment_id` for dispatches, else by app + `commit_sha`) from `queued` to `building`, record the run IDs, and mark any other `queued`/`building` deployments of the app `cancelled`.
- **DEP-2.3** WHEN the fail callback arrives THE SYSTEM SHALL set the deployment `failed` with `CONTRACT_VIOLATION` (validate step) or `BUILD_FAILED` (other steps) and store the details (≤ 20 KB).
- **DEP-2.4** WHEN the artifact upload arrives THE SYSTEM SHALL store it in R2 at `artifacts/<app_id>/<deployment_id>.tar.gz`, set the deployment `deploying`, and start the `DeployApp` workflow.
- **DEP-2.5** IF a callback targets a deployment that is `cancelled`, terminal, or belongs to a deleted app THEN THE SYSTEM SHALL respond 409 and change nothing.
- **DEP-2.6** WHEN `DeployApp` runs THE SYSTEM SHALL validate the artifact structure (`dist/app/wrangler.json`, its main module with a default export, `dist/client/`) and fail with `BUILD_FAILED` if invalid.
- **DEP-2.7** WHEN `DeployApp` runs THE SYSTEM SHALL apply, in filename order, every migration not yet recorded in the app database's `_platform_migrations` table, recording name and SHA-256 of each.
- **DEP-2.8** IF a previously applied migration's content hash has changed, or a migration statement fails THEN THE SYSTEM SHALL fail the deployment with `MIGRATION_FAILED` (naming the file and error) and SHALL leave the current live deployment serving.
- **DEP-2.9** WHEN migrations succeed THE SYSTEM SHALL upload static assets and the Worker script to the dispatch namespace as `script_name` with the platform bindings (spec 09) and `keep_bindings: ["secret_text"]`, ignoring any bindings declared by the app other than `DB` and string `vars`.
- **DEP-2.10** WHEN the script upload succeeds THE SYSTEM SHALL set the deployment `succeeded`, set it as the app's live deployment, and update the KV route to `live`.
- **DEP-2.11** IF uploading to Cloudflare still fails after retries THEN THE SYSTEM SHALL fail the deployment with `DEPLOY_FAILED` and leave the previous live deployment serving.
- **DEP-2.12** WHEN a deployment has been `queued` for 15 minutes or `building` for 20 minutes THE SYSTEM SHALL fail it with `BUILD_FAILED` and a "build did not start / timed out" message.
- **DEP-2.13** WHEN a deployment reaches a terminal state THE SYSTEM SHALL write the `deployment_finished` metric (EVT-2.4).

### DEP-3 — Observe deployments
As an AI client, I want to know whether my change is live or why it failed, so that I can fix it or hand the URL to the user.

- **DEP-3.1** WHEN `get_deployment({ app, deployment? })` is called THE SYSTEM SHALL return the given (or latest) deployment with `status` ∈ `queued | building | deploying | live | superseded | failed | cancelled`, `trigger`, `commit_sha`, timestamps, `url` (when live), `error` (code, message, violations or build-log excerpt — spec 10) and `next_step`.
- **DEP-3.2** WHEN `wait_seconds` (≤ 25) is given THE SYSTEM SHALL wait until the deployment's status changes or becomes terminal, or the time elapses, before responding.
- **DEP-3.3** WHEN `list_deployments({ app, limit?, before? })` is called THE SYSTEM SHALL return up to `limit` (default 10, max 50) deployments, newest first, with a cursor.

### DEP-4 — Redeploy and roll back
As a user, I want to quickly undo a bad change, so that my app keeps working while the AI fixes it.

- **DEP-4.1** WHEN `redeploy({ app })` is called THE SYSTEM SHALL consume one deploy quota unit, create a `queued` deployment (trigger `redeploy`) for the current head of `main`, and dispatch the workflow with its `deployment_id`.
- **DEP-4.2** WHEN `rollback({ app, deployment })` is called for a `superseded` deployment whose artifact exists THE SYSTEM SHALL consume one deploy quota unit, create a deployment (trigger `rollback`, `source_deployment_id`) that skips the build and migrations, and run `DeployApp` with the source artifact.
- **DEP-4.3** IF the target deployment is not `superseded` or its artifact is missing THEN THE SYSTEM SHALL return `DEPLOYMENT_NOT_ROLLBACKABLE`.
- **DEP-4.4** THE SYSTEM SHALL state in the rollback result that database migrations are not reverted and that the next `write_files` with deploy will ship the current code on `main`.

## Non-functional requirements

- Push-to-live for the fixture app p50 < 90 s (dominated by runner start + `npm install`).
- `DeployApp` steps are idempotent and retried (exponential backoff, 5 attempts).
- Artifacts retained for the 20 most recent successful deployments per app; older ones deleted by a daily job (never the live one).

## Out of scope

- Preview deployments / branches.
- Build caching across runs beyond `actions/setup-node` npm cache.
- Reverting D1 migrations.
