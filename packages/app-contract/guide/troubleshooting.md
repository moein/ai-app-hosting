# Troubleshooting

| Symptom | Fix |
|---|---|
| `CONTRACT_VIOLATION` | Fix every item in `error.violations`; each has a rule ID and a `fix`. |
| `BUILD_FAILED` with TypeScript errors | Open the files/lines in `error.errors`, fix the types, write again. |
| `Rollup failed to resolve import "x"` | Add the package to `package.json` dependencies (or fix the import path). |
| `npm error ERESOLVE` / `E404` | Fix the version range or the package name in `package.json`. |
| `MIGRATION_FAILED` | Never edit applied migrations; add a new numbered migration (see `database`). |
| `/api/...` returns the HTML page | `assets.run_worker_first` must include `"/api/*"`, and the route must exist in Hono. |
| Page refresh on a client route returns 404 | `assets.not_found_handling` must be `"single-page-application"`. |
| `Error: Cannot find module 'fs'` (or other Node built-ins) | The runtime isn't Node; use Web APIs or a Workers-compatible package. |
| Exceeded CPU limit | Move heavy work out of the request path; avoid large synchronous loops; paginate queries. |
| Secrets are `undefined` | Set them with `set_secret`; declare them in `Env`; names are case-sensitive. |
| App shows "being built" | No deployment is live yet; check `get_deployment`. |
