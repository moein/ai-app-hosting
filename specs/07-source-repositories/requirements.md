# 07 — Source Repositories: Requirements

Every app has its own private GitHub repository in the platform's GitHub organization. The user never needs a GitHub account; their AI reads and writes files through MCP tools, and the platform turns each write into a git commit on `main`. The platform writes no application code — only managed files.

## Stories & acceptance criteria

### SRC-1 — One repository per app
As the platform, I want each app's code versioned in its own repo, so that every change is reviewable, reproducible and buildable.

- **SRC-1.1** WHEN an app is provisioned THE SYSTEM SHALL create a private repository `GITHUB_ORG/<repo_name>` (`<slug>` in prod, `dev-<slug>` in dev) with default branch `main`, and issues, wiki and projects disabled.
- **SRC-1.2** THE SYSTEM SHALL make the repository's initial commits contain only the managed files (`platform.json`, `.github/workflows/deploy.yml`), with `[skip ci]` in their commit messages so no build is triggered.
- **SRC-1.3** IF the repository already exists and its `platform.json.app` equals the app slug THEN THE SYSTEM SHALL reuse it (idempotent provisioning); IF it exists but belongs to something else THEN provisioning SHALL fail with `CONFLICT`.
- **SRC-1.4** THE SYSTEM SHALL store the repository's numeric GitHub ID on the app (used to authenticate builds, spec 08).
- **SRC-1.5** THE SYSTEM SHALL NOT expose repository URLs or GitHub identifiers in tool outputs in v1.

### SRC-2 — Writing files
As an AI client, I want to create, update and delete many files in one call, so that each coherent change becomes one commit and one deployment.

- **SRC-2.1** WHEN `write_files({ app, files, message, base_commit_sha?, deploy? })` is called THE SYSTEM SHALL create exactly one commit on `main` applying all file operations (`upsert` with `content`, or `delete`).
- **SRC-2.2** THE SYSTEM SHALL accept file content as UTF-8 text by default, or base64 when `encoding: "base64"` is given.
- **SRC-2.3** IF any path is absolute, contains `..`, `\`, `//`, a leading `./`, a `.git/` segment, control characters, or exceeds 256 characters THEN THE SYSTEM SHALL return `INVALID_INPUT` and commit nothing.
- **SRC-2.4** IF any operation targets a managed path (`.github/**`, `platform.json`) THEN THE SYSTEM SHALL return `PROTECTED_PATH` listing the paths and commit nothing.
- **SRC-2.5** IF any single file exceeds `MAX_FILE_BYTES`, or the call has more than `MAX_FILES_PER_WRITE` operations or more than `MAX_WRITE_BYTES` total content THEN THE SYSTEM SHALL return `FILE_TOO_LARGE` or `PAYLOAD_TOO_LARGE` and commit nothing.
- **SRC-2.6** IF `base_commit_sha` is given and differs from the current head of `main` THEN THE SYSTEM SHALL return `COMMIT_CONFLICT` with `details.head_commit_sha` and commit nothing.
- **SRC-2.7** WHEN `base_commit_sha` is omitted and `main` moves between reading the head and updating the ref THE SYSTEM SHALL rebuild the commit on the new head once, and IF it still races THEN return `COMMIT_CONFLICT`.
- **SRC-2.8** WHEN `deploy` is true (default) THE SYSTEM SHALL consume one deploy quota unit before committing (returning `QUOTA_EXCEEDED` and committing nothing if exhausted), and after committing SHALL create a `queued` deployment for the new commit (spec 08) and return it.
- **SRC-2.9** WHEN `deploy` is false THE SYSTEM SHALL append `[skip ci]` to the commit message and SHALL NOT create a deployment.
- **SRC-2.10** THE SYSTEM SHALL author commits as the platform's GitHub App bot and add trailers `Platform-User: <usr_id>` and `Platform-App: <app_id>`.
- **SRC-2.11** WHEN the operations produce no change to the tree THE SYSTEM SHALL create no commit and no deployment and return `{ no_changes: true, commit_sha: <head> }`.
- **SRC-2.12** WHEN the commit succeeds THE SYSTEM SHALL return `{ commit_sha, files_changed, deployment, next_step }`.
- **SRC-2.13** THE SYSTEM SHALL treat deleting a path that doesn't exist as a no-op and report it in `skipped`.

### SRC-3 — Reading files
As an AI client in a fresh conversation, I want to read the current code, so that I can continue work without the previous chat.

- **SRC-3.1** WHEN `list_files({ app, prefix?, ref? })` is called THE SYSTEM SHALL return every file path under `prefix` at `ref` (default: head of `main`) with its size and a `managed` flag, plus the resolved `commit_sha`.
- **SRC-3.2** WHEN `read_file({ app, path, ref?, offset?, limit? })` is called THE SYSTEM SHALL return the file's content as UTF-8 text, or base64 (`encoding: "base64"`) for binary files.
- **SRC-3.3** IF a text file's content exceeds `READ_FILE_MAX_BYTES` from `offset` THEN THE SYSTEM SHALL return a chunk ending on a line boundary with `truncated: true` and `next_offset`.
- **SRC-3.4** IF the path or ref doesn't exist THEN THE SYSTEM SHALL return `NOT_FOUND`.
- **SRC-3.5** `ref` SHALL accept only a full or abbreviated (≥ 7 chars) commit SHA reachable from `main`, or be omitted.

### SRC-4 — GitHub integration
As the platform, I want safe, least-privilege access to GitHub, so that one compromised token can't affect other apps.

- **SRC-4.1** THE SYSTEM SHALL authenticate as a GitHub App and use installation tokens scoped to the single target repository for all per-app operations (org-wide token only for repo creation).
- **SRC-4.2** THE SYSTEM SHALL cache installation tokens until 5 minutes before expiry.
- **SRC-4.3** WHEN GitHub returns 5xx, a secondary rate limit, or a network error THE SYSTEM SHALL return `UPSTREAM_ERROR` (retryable) with `details.retry_after_seconds` when known.

## Non-functional requirements

- `write_files` with 50 small files completes p95 < 8 s.
- No file content is logged or tracked (EVT-1.4).

## Out of scope

- Branches other than `main`, pull requests, direct `git push` by users.
- Transferring the repo to the user's own GitHub account (later).
- Git LFS.
