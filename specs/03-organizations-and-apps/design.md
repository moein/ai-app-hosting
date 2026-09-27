# 03 — Organizations & Apps: Design

## Data model (platform D1)

```sql
CREATE TABLE organizations (
  id                 TEXT PRIMARY KEY,                -- org_…
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'personal',-- v1: 'personal'
  email_tenant_status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'ready' | 'failed' (spec 11)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'owner',           -- v1: 'owner'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE apps (
  id                   TEXT PRIMARY KEY,               -- app_…
  org_id               TEXT NOT NULL REFERENCES organizations(id),
  slug                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active', -- 'active' | 'deleted'
  provisioning         TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'ready' | 'failed'
  provisioning_error   TEXT,                           -- error code when failed
  script_name          TEXT NOT NULL,                  -- = slug (lowercase; IDs are case-sensitive)
  repo_owner           TEXT NOT NULL,                  -- GITHUB_ORG
  repo_name            TEXT NOT NULL,                  -- slug (prod) / dev-<slug> (dev)
  repo_id              INTEGER,                        -- GitHub numeric id (OIDC check, spec 08)
  d1_database_id       TEXT,                           -- Cloudflare D1 uuid
  d1_database_name     TEXT NOT NULL,                  -- app-<slug>-<env>
  live_deployment_id   TEXT,                           -- dep_… (spec 08)
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX apps_org_status_created ON apps (org_id, status, created_at DESC);

CREATE TABLE usage_counters (
  org_id  TEXT NOT NULL REFERENCES organizations(id),
  metric  TEXT NOT NULL,        -- 'deploys' | 'emails'
  day     TEXT NOT NULL,        -- 'YYYY-MM-DD' UTC
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, metric, day)
);
```

Quota increment (atomic, check-and-increment in one statement):

```sql
INSERT INTO usage_counters (org_id, metric, day, count) VALUES (?, ?, ?, 1)
ON CONFLICT (org_id, metric, day) DO UPDATE SET count = count + 1
WHERE usage_counters.count < ?        -- max
RETURNING count;                       -- no row returned ⇒ QUOTA_EXCEEDED
```

## Limits

| Constant | Initial value |
|---|---|
| `MAX_APPS_PER_ORG` | 10 |
| `MAX_DEPLOYS_PER_ORG_PER_DAY` | 150 |
| `MAX_EMAILS_PER_ORG_PER_DAY` | 300 |
| `CREATE_APP_WAIT_MS` | 25_000 |

## Provisioning — `ProvisionApp` Workflow

Cloudflare Workflow in `apps/api`. Params: `{ appId }`. Each step is idempotent and retried (exponential backoff, 5 retries).

```
step "d1"      : if apps.d1_database_id null → Cloudflare API create D1 `app-<slug>-<env>`
                 (if name exists → look it up) → save id
step "repo"    : GitHub: create private repo in GITHUB_ORG (if exists → reuse) → commit managed files
                 (.github/workflows/deploy.yml, platform.json) → save repo_id           [spec 07]
step "script"  : upload placeholder Worker to dispatch namespace as `script_name`
                 (keep_bindings: secret_text), bindings: none                            [spec 09]
step "route"   : KV APP_ROUTES put `<slug>` → { appId, scriptName, state: 'not_deployed' } [spec 09]
step "email"   : EMAIL_JOBS send { type: 'app.provision_email_identity', appId } (the app's SES identity,
                 finished asynchronously by the email worker; not awaited)                 [spec 11]
step "ready"   : UPDATE apps SET provisioning='ready'
on final failure: UPDATE apps SET provisioning='failed', provisioning_error=<code>
```

`create_app` inserts the row, creates the workflow instance (id = `provision-<appId>-<attempt>`), then polls `instance.status()` every 1 s until complete or `CREATE_APP_WAIT_MS` elapses.

## Deletion

```
delete_app(app, confirm_slug):
  load app (org-scoped) → NOT_FOUND / APP_DELETED
  confirm_slug !== slug → INVALID_INPUT
  UPDATE deployments SET status='cancelled' WHERE app_id=? AND status IN ('queued','building','deploying')
  Cloudflare API: DELETE dispatch namespace script `script_name` (404 ⇒ ok)
  KV delete `<slug>`
  D1 batch: DELETE app_secrets WHERE app_id=?; UPDATE apps SET status='deleted', deleted_at=now
```

Kept: GitHub repo, D1 database, `ARTIFACTS` objects, log archives, `deployments` rows. The build-callback endpoint (spec 08) rejects uploads for deleted apps.

## MCP tool contracts

```ts
type AppSummary = {
  slug: string; name: string; url: string;               // https://<slug>.APPS_DOMAIN
  status: 'active' | 'deleted';
  provisioning: 'pending' | 'ready' | 'failed';
  live_deployment: { id: string; commit_sha: string; deployed_at: string } | null;
  created_at: string;
};

create_app          in { name: string; slug?: string }        out AppSummary & { next_step }
list_apps           in {}                                     out { apps: AppSummary[] }
get_app             in { app: string }                        out AppSummary & {
                                                                provisioning_error?: string;
                                                                latest_deployment: DeploymentSummary | null;  // spec 08
                                                                repo: { default_branch: 'main'; head_commit_sha: string | null } }
retry_provisioning  in { app: string }                        out AppSummary
delete_app          in { app: string; confirm_slug: string }  out { slug; status: 'deleted';
                                                                kept: ['source code', 'database', 'deployment history'] }
get_usage           in {}                                     out { apps: {used, max}, deploys_today: {used, max, resets_at},
                                                                emails_today: {used, max, resets_at} }
```

`create_app.next_step`: "The repo is empty except for platform-managed files. Follow get_platform_guide, write the app with write_files, then watch the deployment with get_deployment."

`delete_app` tool description instructs the AI to confirm with the user first and explains that code and data are kept.

## Error codes (added)

| Code | retryable | Hint |
|---|---|---|
| `NAME_INVALID` | false | App names must be 1–60 characters. Ask the user for a shorter/cleaner name. |
| `APP_NOT_READY` | true | The app is still being set up (or setup failed). Call `get_app`; if `provisioning` is `failed`, call `retry_provisioning`. |
| `APP_DELETED` | false | This app was deleted. Create a new app, or tell the user deleted apps can't be restored yet. |

## Open questions

1. Restoring deleted apps (redeploy last artifact + recreate route) — cheap to add since resources are kept.
2. Purge policy for deleted apps' repo/D1/artifacts (cost, GDPR). Needs a decision before public launch.
3. Do deleted apps count toward `MAX_APPS_PER_ORG`? Current design: no (only `active`).
4. `rename_app` (display name only) — trivial; include in v1?
