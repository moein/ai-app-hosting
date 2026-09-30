# 14 — Website: Design

## Worker `apps/website`

React SPA built with Vite + `@cloudflare/vite-plugin` and served as Workers static assets, plus a tiny Worker for `GET /api/config` → `{ mcpUrl, connectorName }` (from `vars`; the SPA fetches it so one build serves every environment). No D1, no secrets.

| Env | Route | vars |
|---|---|---|
| dev | `APPS_DOMAIN/*` (apex; moved from the dispatcher) | `MCP_URL = PLATFORM_API_ORIGIN/mcp`, `CONNECTOR_NAME = "AI App Hosting (dev)"` |
| prod | added with the prod domain | `CONNECTOR_NAME = "AI App Hosting"` |

The dispatcher keeps `*.APPS_DOMAIN/*` and redirects `www.` to `PLATFORM_WEBSITE_URL` (`https://APPS_DOMAIN`). The apex needs no app slug, so it can't collide with apps.

Security headers on every response: HSTS, `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. HTTP → HTTPS redirect in the Worker.

## Flow (`src/web/`)

```
Step 1  "Which AI do you use?"      [Claude]  ChatGPT · Gemini · Other — "coming soon"
Step 2  "Connect Claude"            CLAUDE_STEPS: { title, text, image, width, height, alt }[]
                                     connector name + MCP URL with copy buttons   [Back] [Done]
Step 3  "What app do you want?"     textarea (required, ≤ 2,000 chars)
                                     toggle: Only me ◯── Several people           [Back] [Create my prompt]
Step 4  "Your prompt"               read-only prompt  [Copy prompt]  [Open Claude ↗ claude.ai/new]  [Start over]
```

State lives in React only (WEB-1.7); the step is mirrored in the URL hash (`#/connect`, …) so the browser Back button works. Screenshots live in `public/claude/` with their pixel sizes declared in `CLAUDE_STEPS` (no layout shift).

## Prompt (`src/web/prompt.ts`, pure)

`buildPrompt({ description, audience: 'me' | 'many', connectorName })` →

```
I want you to build and host a web app for me with the "<connectorName>" connector.

What the app should do:
<description, trimmed>

Who will use it:
<me>   Only me. Keep it private: add a sign-in with my email address (a one-time code sent by email) and only let my email in — ask me which email to use.
<many> Several people. Let people sign up and sign in with their email address (a one-time code sent by email). Each person should only see their own data, unless sharing is part of what the app does.

How to do it:
1. Before writing any code, read the platform guide (all topics) and follow it exactly.
2. Create the app, write all of its code, deploy it and follow the build until it's live. If anything fails, read the errors and logs, fix it and deploy again.
3. When it works, give me the link and a short, non-technical explanation of how to use it.

I'm not technical: make the technical decisions yourself and only ask me about what the app should do.
```

## Limits

| Constant | Value |
|---|---|
| `WEBSITE_APP_DESCRIPTION_MAX_CHARS` | 2_000 (constant removed from `limits.ts`; define it in the homepage project) |

## Open questions

1. Instructions for ChatGPT (custom connector / directory app) and others.
2. Once the platform is in Claude's Connectors Directory, step 2 becomes "click Connect".
