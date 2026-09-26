# Workflow

**You write all of the app's code.** The platform provides no templates, starter code or generated code. A new app's repository contains only two platform-managed files — `.github/workflows/deploy.yml` and `platform.json` — which you must never edit. Every other file is yours to create, following the `contract` topic exactly.

## 1. Log in
Call `whoami`. If it says you're not authenticated, ask the user for their email address, call `request_login_code`, ask the user for the 6-digit code from their inbox, and call `verify_login_code`. The same flow signs new users up.

## 2. Create or pick an app
- New app: `create_app({ name })`, optionally with a `slug` (the subdomain). The app lives at `https://<slug>.{{APPS_DOMAIN}}`.
- Existing app: `list_apps`, then `get_app({ app })`.
- In a new conversation, restore context with `list_files` and `read_file` before changing anything.

## 3. Write the code
- Follow the `contract` topic exactly (files, `wrangler.jsonc`, `vite.config.ts`, dependencies).
- `write_files` commits many files at once: up to {{MAX_FILES_PER_WRITE}} files and {{bytes:MAX_WRITE_BYTES}} per call, {{bytes:MAX_FILE_BYTES}} per file.
- Every commit with `deploy: true` (the default) is built and deployed. For large apps, write in batches with `deploy: false` and set `deploy: true` only on the last batch.
- Never commit build output, `node_modules/`, lockfiles other than `package-lock.json`, or secrets.

## 4. Follow the deployment
Call `get_deployment({ app, wait_seconds: 25 })` repeatedly until `status` is `live` or `failed`.
- `failed` with `CONTRACT_VIOLATION`: fix every item in `error.violations` (each has a `fix`), then write again.
- `failed` with `BUILD_FAILED`: read `error.errors` (file, line, message) and `error.build_log_excerpt`, fix, write again.
- `failed` with `MIGRATION_FAILED`: see the `database` topic.

## 5. Verify and hand over
When `live`, give the user the URL. Use `get_logs` to see requests, console output and exceptions, and `query_database` to inspect data.

## 6. Undo
`rollback({ app, deployment })` re-ships a previous live version (database migrations are not reverted). The next `write_files` with `deploy: true` ships the current code again.
