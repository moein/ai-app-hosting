# Connecting an AI client to the platform

The platform is a remote MCP server (Streamable HTTP) protected by its own OAuth 2.1 authorization server
(spec 02, AUTH-4). A client that supports MCP's OAuth discovery (dynamic client registration, PKCE) finds and
authorizes itself automatically — there's nothing to configure by hand.

| Environment | MCP server URL |
|---|---|
| dev | `https://api-dev.ai-app-hosting.workers.dev/mcp` |
| prod | `PLATFORM_API_ORIGIN/mcp` once prod is set up (specs/values.md) |

## Claude (claude.ai web, desktop, mobile)

1. **Settings → Connectors → Add custom connector.**
2. Name: `AI App Hosting (dev)`; URL: the MCP server URL above. **Add.**
3. Claude opens our sign-in page in a browser tab: enter your email, then the 6-digit code sent to it. Once
   it redirects back, the connector is signed in — no code is ever typed into the chat.
4. In a new chat, open the tools menu and make sure the connector is enabled. Connectors added on the web are also available in the desktop and mobile apps.

Claude Code: `claude mcp add --transport http ai-app-hosting https://api-dev.ai-app-hosting.workers.dev/mcp`

## ChatGPT

Settings → Apps & Connectors → Advanced → enable Developer mode → **Create**: MCP server URL as above, authentication **OAuth**. ChatGPT discovers the authorization server and walks you through the same email + code sign-in page. Enable it in the chat's tools menu.

## Starter prompt

Paste this into a new chat (fill in the placeholder):

```
I want to build and host a web app with the AI App Hosting connector.

1. Before writing anything, read the platform guide (all topics) and follow its app contract exactly.
2. Build this app: <DESCRIBE THE APP — what it does, who uses it, what they can do>.
3. This app has its own users, separate from my platform account. Build it for multiple users from the
   start, but ask me whether anyone may sign up or only specific email addresses (an allowlist). For
   signing people into the app, use an emailed 6-digit login code by default — only build something else
   if I ask for it.
4. Create the app, write all the code, deploy it, and follow the build until it's live. If the build or
   the app fails, read the errors and logs, fix the code yourself and deploy again.
5. When it works, give me the link and a short summary of what you built.

I'm not technical: make sensible technical choices yourself and only ask me about what the app should do.
```

## Client compatibility checklist (spec 04 task 6)

Run the starter prompt in each client and tick: OAuth sign-in completes (browser tab, email + code, redirects back) → `get_platform_guide` read → `create_app` → `write_files` → deployment followed to `live` → app URL works → a follow-up request ("show me the latest errors") uses `get_logs`.

| Client | Result |
|---|---|
| MCP Inspector 2.8.0 (CLI, Streamable HTTP) | pre-OAuth: tools/list (24 tools) and `whoami` OK — 2026-09-28; _re-run against the OAuth flow pending_ |
| Claude | OAuth connector flow, full journey — verified by the operator 2026-09-30 |
| ChatGPT | OAuth connector flow, full journey — verified by the operator 2026-09-30 |
