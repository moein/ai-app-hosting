# 07 — Source Repositories: Design

## GitHub App

One GitHub App per environment (`<platform>-dev`, `<platform>-prod`) installed on `GITHUB_ORG`.

| Permission | Level | Why |
|---|---|---|
| Administration | write | create repos |
| Contents | write | commits, reads |
| Workflows | write | commit `.github/workflows/deploy.yml` |
| Actions | write | read job logs (spec 10), `workflow_dispatch` for redeploy (spec 08) |
| Metadata | read | required |

Secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM), `GITHUB_INSTALLATION_ID`.

## `GitHubClient` interface (`apps/api/src/integrations/github.ts`)

```ts
interface GitHubClient {
  createRepo(name: string, description: string): Promise<{ id: number; created: boolean }>;
  getRepo(name: string): Promise<{ id: number } | null>;
  getHead(repo: string): Promise<{ commitSha: string; treeSha: string } | null>;   // null = empty repo
  putFileOnEmptyRepo(repo: string, path: string, content: string, message: string): Promise<string>;
  commit(repo: string, p: { parentSha: string; baseTreeSha: string; entries: TreeEntry[];
                            message: string }): Promise<{ commitSha: string; treeSha: string; changed: boolean }>;
  updateMain(repo: string, sha: string): Promise<'ok' | 'not_fast_forward'>;
  listTree(repo: string, ref: string): Promise<{ commitSha: string; files: { path: string; size: number; sha: string }[] }>;
  readBlob(repo: string, ref: string, path: string): Promise<{ content: Uint8Array } | null>;
  dispatchWorkflow(repo: string, workflow: 'deploy.yml', inputs: Record<string, string>): Promise<void>;
  getJobLog(repo: string, jobId: number): Promise<string>;              // spec 10
}
```

Token handling: sign an RS256 JWT (`iat - 60`, `exp + 9 min`, `iss = GITHUB_APP_ID`) with WebCrypto; exchange at `POST /app/installations/{id}/access_tokens` with `{ repositories: [repo] }` for scoped tokens (SRC-4.1). Cache in-isolate `Map<repo, {token, expiresAt}>` (SRC-4.2). A fake implementation backs tests.

## Repo creation (called by `ProvisionApp`, spec 03)

```
repo = getRepo(repo_name)
if repo:
   platform.json at main → .app == slug ? reuse : CONFLICT          (SRC-1.3)
else:
   createRepo(repo_name, name) (private, has_issues/wiki/projects false, auto_init false)
if getHead(repo) == null:
   putFileOnEmptyRepo(repo, 'platform.json', json, 'Initialize platform.json [skip ci]')   # Git Data API can't write to empty repos
if deploy.yml missing:
   commit(entries=[deploy.yml], message='Add managed deploy workflow [skip ci]'); updateMain
save repo_id
```

## `write_files` algorithm

```
input:
  app: slug
  files: Array< { path, op?: 'upsert', content: string, encoding?: 'utf8' | 'base64' }
               | { path, op: 'delete' } >               (1..MAX_FILES_PER_WRITE)
  message: string (1..200 chars)
  base_commit_sha?: string
  deploy?: boolean = true

1. resolveApp(requireReady)                                           (APP-3.x)
2. validate paths (SRC-2.3), protected (SRC-2.4), sizes (SRC-2.5) — all before any I/O
3. if deploy: consumeDaily('deploys')  → QUOTA_EXCEEDED                (SRC-2.8)
4. head = getHead(repo); if base_commit_sha && !head.commitSha.startsWith(base) → COMMIT_CONFLICT
5. entries = upserts → { path, mode: '100644', type: 'blob', content | sha(blob for base64) }
             deletes → { path, sha: null }   (skip + report paths absent from tree: SRC-2.13)
6. msg = message + (deploy ? '' : ' [skip ci]') + '\n\nPlatform-User: usr_…\nPlatform-App: app_…'
7. c = commit(...); if !c.changed → { no_changes: true, commit_sha: head } (refund quota)   (SRC-2.11)
8. updateMain(c.commitSha): not_fast_forward → if base given: COMMIT_CONFLICT
                                               else: retry once from step 4 on the new head    (SRC-2.7)
9. if deploy: INSERT deployments (status 'queued', trigger 'push', commit_sha)              (spec 08)
10. return { commit_sha, files_changed, skipped, deployment: { id, status } | null, next_step }
```

`changed` is determined by comparing the new tree SHA with the base tree SHA.

The commit is created with the App's installation token, so the push event **does** trigger GitHub Actions (events from `GITHUB_TOKEN` would not).

`next_step` (deploy): "Call get_deployment with deployment=<id> and wait_seconds=25 until status is live or failed."
`next_step` (no deploy): "Files saved without deploying. Call write_files with deploy=true (or redeploy) when ready."

## `list_files` / `read_file`

- `list_files`: `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`; filter `type == 'blob'` and prefix; `managed = path in MANAGED_PATHS || path.startsWith('.github/')`.
- `read_file`: tree lookup → `GET /repos/{o}/{r}/git/blobs/{sha}` (base64) → decode; text detection = valid UTF-8 and no NUL bytes in the first 8 KB; chunking by `offset` (bytes) to ≤ `READ_FILE_MAX_BYTES`, cut back to last `\n`.

## Limits

| Constant | Value |
|---|---|
| `MAX_FILE_BYTES` | 1_000_000 |
| `MAX_FILES_PER_WRITE` | 200 |
| `MAX_WRITE_BYTES` | 5_000_000 |
| `READ_FILE_MAX_BYTES` | 80_000 |
| `MAX_PATH_LENGTH` | 256 |

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `PROTECTED_PATH` | false | `details.paths` are managed by the platform and can't be changed. Remove them from the request. |
| `FILE_TOO_LARGE` | false | `details.path` exceeds the per-file limit. Split it or shrink it (no bundled/build output in the repo). |
| `PAYLOAD_TOO_LARGE` | false | Too many files or bytes in one call. Split into several write_files calls with deploy=false, then deploy with the last one. |
| `COMMIT_CONFLICT` | true | The code changed since `base_commit_sha`. Re-read the affected files at `details.head_commit_sha`, reapply your changes, retry. |

## Open questions

1. Managed-file upgrades (new `deploy.yml` versions): platform commits them with `[skip ci]` in bulk, or lazily on next deploy?
2. Should `read_file` accept multiple paths to cut round-trips for AIs restoring context?
3. GitHub org repo limits and API rate limits (5,000 req/h per installation) at scale — consider one installation per N apps or multiple orgs.
