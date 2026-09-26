/** Server `instructions` sent in the initialize result (MCP-2.1). Must stay ≤ 2,000 characters. */
export function buildInstructions(appsDomain: string): string {
  return `This server hosts full-stack web apps. You (the AI) write ALL of the app's code; the platform
stores, builds, deploys and runs it at https://<app>.${appsDomain}. The platform never generates code.

1. Login: call whoami. If not authenticated, ask the user for their email, call request_login_code,
   ask the user for the 6-digit code from their inbox, then call verify_login_code.
2. Before writing any code, call get_platform_guide and follow its app contract exactly
   (Hono API + React SPA on one Cloudflare Worker, D1 database, wrangler.jsonc).
3. create_app (or list_apps to continue an existing one).
4. write_files to commit code. Every commit to main is built and deployed automatically.
5. get_deployment with wait_seconds to follow the build. If it fails, read the errors, fix the
   files, and write again. When live, give the user the URL.
6. Use get_logs, query_database, set_secret to debug and operate the app.
Every error includes a \`hint\` telling you what to do next.`;
}
