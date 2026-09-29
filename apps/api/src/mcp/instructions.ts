/** Server `instructions` sent in the initialize result (MCP-2.1). Must stay ≤ 2,000 characters. */
export function buildInstructions(appsDomain: string): string {
  return `This server hosts full-stack web apps. You (the AI) write ALL of the app's code; the platform
stores, builds, deploys and runs it at https://<app>.${appsDomain}. The platform never generates code.

The user is already signed in through the connector (whoami shows who).
1. Before writing any code, call get_platform_guide and follow its app contract exactly
   (Hono API + React SPA on one Cloudflare Worker, D1 database, wrangler.jsonc).
2. create_app (or list_apps to continue an existing one).
3. write_files to commit code. Every commit to main is built and deployed automatically.
4. get_deployment with wait_seconds to follow the build. If it fails, read the errors, fix the
   files, and write again. When live, give the user the URL.
5. Use get_logs, query_database, list_storage_objects, set_secret to debug and operate the app.
Every error includes a \`hint\` telling you what to do next.`;
}
