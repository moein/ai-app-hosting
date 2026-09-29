# 04 — MCP Server: Design

## Architecture

```
apps/api (Worker, Hono — route groups mounted in src/http/app.ts, see 00 design "HTTP routing")
  /mcp           → mcpRoutes → McpSession.serve('/mcp', { binding: 'MCP_SESSION' })   agents SDK, Streamable HTTP
                    └─ McpSession extends McpAgent (Durable Object, SQLite-backed, one per Mcp-Session-Id)
                         server: low-level SDK `Server` (tools capability + instructions)
                         init(): installs tools/list + tools/call handlers backed by the tool registry
                         session data in this.ctx.storage: { auth, loginCodeRequests } (spec 02);
                         client info from getInitializeRequest() (spec 05)
  /v1/builds/*   → buildsRoutes (spec 08)
  /v1/contract/* → contractRoutes (spec 06)
  /v1/ses/*      → sesRoutes (spec 11)
  /healthz       → healthRoutes
```

## SDK choices

- `agents` `McpAgent` requires `@modelcontextprotocol/sdk` **1.30.0** exactly (peer dependency), so the platform pins 1.30.0 instead of the latest patch (see CLAUDE.md dependency table).
- The server is the SDK's **low-level `Server`**, not `McpServer`: `tools/list` and `tools/call` are handled by our registry, so input validation, error results (`isError` + `PlatformError`), output validation and the size cap follow MCP-3 exactly instead of the SDK's built-in behavior. Input/output JSON Schemas for `tools/list` come from Zod (`z.toJSONSchema`).
- Session data lives in the Durable Object's own storage (`this.ctx.storage`), not in Agent `state`, so it is never synced to connected clients.

## Tool registry

```ts
defineTool({
  name: 'get_app',
  title: 'Get app details',
  description: '…',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({ app: AppSlug }),
  output: AppDetail,
  handler: async (input, ctx) => { … },           // ctx: { env, userId?, orgId?, sessionId, client, clock, integrations }
});
```

Middleware chain (MCP-3.7), each a function `(ctx, next) => Promise<Result>`:

```
track       — starts timer; always emits one event after completion (spec 05; until then it logs tool, outcome, error code and duration — never arguments)
authGuard   — spec 02
rateLimit   — Workers Rate Limiting binding `TOOL_RATE_LIMITER` keyed by userId (60 s window); skipped for calls without a user
validateIn  — Zod parse → INVALID_INPUT {issues}
handler
validateOut — Zod parse of output → INTERNAL on failure (MCP-3.9)
serialize   — { structuredContent: out, content: [{ type:'text', text: JSON.stringify(out) }] }
              or on PlatformError: { isError: true, content: [{ type:'text', text: JSON.stringify({ error }) }],
                                     structuredContent: { error } }
              + 100 KB cap check (MCP-3.6): an oversized result becomes INTERNAL and is logged (tools must truncate their own fields)
```

## Tool catalog (MCP-3.1)

Annotations: R = readOnly, D = destructive, I = idempotent, O = openWorld.

| Tool | Title | Ann. | Spec | Purpose |
|---|---|---|---|---|
| `get_platform_guide` | Read the platform guide | R I | 04 | How to build/ship apps here (contract, workflow, limits) |
| `whoami` | Who am I | R I | 02 | The signed-in user |
| `get_usage` | Show usage and quotas | R I | 03 | Quotas and usage |
| `check_slug` | Check an app address | R I | 01 | Is an app address valid/available |
| `create_app` | Create an app | — | 03 | Create app (repo, DB, placeholder Worker, subdomain) |
| `retry_provisioning` | Retry app setup | I | 03 | Retry failed setup |
| `list_apps` | List my apps | R I | 03 | List active apps |
| `get_app` | Show an app | R I | 03 | App details + deployment state |
| `delete_app` | Delete an app | D | 03 | Take app offline (deletes Worker only) |
| `list_files` | List app files | R I | 07 | List repo files (paths, sizes) |
| `read_file` | Read an app file | R I | 07 | Read file contents |
| `write_files` | Write app files | D | 07 | Create/update/delete files in one commit; triggers a deploy |
| `list_deployments` | List deployments | R I | 08 | Deployment history |
| `get_deployment` | Show a deployment | R I | 08/10 | Status, errors, build log excerpt; optional wait |
| `redeploy` | Redeploy the app | — | 08 | Rebuild + deploy current `main` |
| `rollback` | Roll back to a deployment | — | 08 | Re-ship a previous successful artifact |
| `get_logs` | Show app logs | R I | 10 | Runtime logs of the live app |
| `set_secret` | Set a secret | I | 09 | Set an env secret |
| `list_secrets` | List secrets | R I | 09 | Secret names (never values) |
| `delete_secret` | Delete a secret | D I | 09 | Remove a secret |
| `query_database` | Query the app database | D | 09 | Run SQL against the app's D1 |

Every tool requires the OAuth bearer token (spec 02, AUTH-4); there are no public tools.

`write_files`, `delete_app`, `delete_secret`, `query_database` descriptions tell the AI when to confirm with the user.

## Server `instructions` (draft, MCP-2.1)

```
This server hosts full-stack web apps. You (the AI) write ALL of the app's code; the platform
stores, builds, deploys and runs it at https://<app>.APPS_DOMAIN. The platform never generates code.

The user is already signed in through the connector (whoami shows who).
1. Before writing any code, call get_platform_guide and follow its app contract exactly
   (Hono API + React SPA on one Cloudflare Worker, D1 database, wrangler.jsonc).
2. create_app (or list_apps to continue an existing one).
3. write_files to commit code. Every commit to main is built and deployed automatically.
4. get_deployment with wait_seconds to follow the build. If it fails, read the errors, fix the
   files, and write again. When live, give the user the URL.
5. Use get_logs, query_database, set_secret to debug and operate the app.
Every error includes a `hint` telling you what to do next.
```

## Platform guide (MCP-2.2 – 2.5)

Source: `packages/app-contract/guide/*.md` (one file per topic). `pnpm -F @repo/app-contract build:guide` compiles them into `src/guide-sources.generated.ts` (committed; a unit test fails if it is stale), so no bundler text-module rules are needed. At request time `renderGuide(topic, { appsDomain })` replaces placeholders:

| Placeholder | Replaced with |
|---|---|
| `{{LIMIT_NAME}}` | the constant from `packages/shared/limits.ts` (numbers formatted with separators) |
| `{{bytes:LIMIT_NAME}}` | the constant as a human size (e.g. `1 MB`) |
| `{{CONTRACT_VERSION}}` | `packages/app-contract/src/version.ts` |
| `{{APPS_DOMAIN}}` | the worker's `APPS_DOMAIN` var |
| `{{RULES}}` | the rule table from `rules.ts` |
| `{{DENYLIST}}` | the table from `denylist.ts` |
| `{{REQUIRED_DEPENDENCIES}}` | the minimum-version table from `version.ts` |

Topic `all` (default) is every topic in the order below, joined.

| Topic | Content |
|---|---|
| `workflow` | Login → create → write → deploy → verify loop; batching writes (`deploy: false` until ready); reading build errors; rollback |
| `contract` | Spec 06 in full: required files, `wrangler.jsonc` rules, bindings, allowed deps, forbidden APIs, versions |
| `database` | D1 + Drizzle usage, `migrations/NNNN_name.sql` rules, `query_database` |
| `email` | `env.EMAIL.send()` API and limits (spec 11) |
| `secrets` | `set_secret`, reading via `env`, naming rules |
| `limits` | All quotas and sizes |
| `troubleshooting` | Common build/runtime errors → fixes |

Output: `{ contract_version: string; topic: string; markdown: string }`.

## Result conventions

- Timestamps in outputs: ISO 8601 strings.
- Apps referenced by `app` (slug) everywhere; deployments by `deployment` (`dep_…`).
- `next_step` is a plain imperative sentence addressed to the AI.
- Truncation: `{ …, truncated: true, next_step: "Call read_file with offset=…" }`.

## Limits

| Constant | Value |
|---|---|
| `TOOL_CALLS_PER_USER_PER_MINUTE` | 120 |
| `TOOL_RESULT_MAX_BYTES` | 100_000 |
| `TOOL_MAX_DURATION_MS` | 30_000 |

## Error codes

Uses the shared catalog; no new codes.

## Open questions

1. Should we also expose the guide as an MCP resource for clients that surface resources well (optional, never required)?
2. Tool-count budget: if some clients degrade with ~24 tools, consider merging (`secrets` into one tool with `action`).
3. MCP protocol version pinning vs. following the SDK default.
