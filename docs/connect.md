# Connecting an AI client to the platform

The platform is a remote MCP server (Streamable HTTP, no OAuth — sign-in happens inside the chat with an emailed code).

| Environment | MCP server URL |
|---|---|
| dev | `https://api-dev.ai-app-hosting.workers.dev/mcp` |
| prod | `PLATFORM_API_ORIGIN/mcp` once prod is set up (specs/values.md) |

## Claude (claude.ai web, desktop, mobile)

1. **Settings → Connectors → Add custom connector.**
2. Name: `AI App Hosting (dev)`; URL: the MCP server URL above. Leave OAuth settings empty. **Add.**
3. In a new chat, open the tools menu and make sure the connector is enabled. Connectors added on the web are also available in the desktop and mobile apps.

Claude Code: `claude mcp add --transport http ai-app-hosting https://api-dev.ai-app-hosting.workers.dev/mcp`

## ChatGPT

Settings → Apps & Connectors → Advanced → enable Developer mode → **Create**: MCP server URL as above, authentication **None**. Enable it in the chat's tools menu.

## Starter prompt

Paste this into a new chat (fill in the two placeholders):

```
I want to build and host a web app with the AI App Hosting connector.

1. Sign me in with my email <YOUR EMAIL>. You'll get a 6-digit code request — ask me for the code from my inbox.
2. Before writing anything, read the platform guide (all topics) and follow its app contract exactly.
3. Build this app: <DESCRIBE THE APP — what it does, who uses it, what they can do>.
4. Create the app, write all the code, deploy it, and follow the build until it's live. If the build or
   the app fails, read the errors and logs, fix the code yourself and deploy again.
5. When it works, give me the link and a short summary of what you built.

I'm not technical: make sensible technical choices yourself and only ask me about what the app should do.
```

## Client compatibility checklist (spec 04 task 6)

Run the starter prompt in each client and tick: login with the emailed code → `get_platform_guide` read → `create_app` → `write_files` → deployment followed to `live` → app URL works → a follow-up request ("show me the latest errors") uses `get_logs`.

| Client | Result |
|---|---|
| MCP Inspector 2.8.0 (CLI, Streamable HTTP) | tools/list (24 tools) and `whoami` OK — 2026-09-28 |
| Claude | _to run_ |
| ChatGPT | _to run_ |
