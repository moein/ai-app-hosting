# 14 — Website: Tasks

Depends on: 09 (dispatcher routes), 04 (MCP URL).

- [x] **1. `apps/website` Worker + routes**
  Scaffold (Vite, React, `wrangler.jsonc`), `/api/config`, security headers, HTTP → HTTPS; move the apex route from the dispatcher; deploy script includes it.
  Satisfies: WEB-1.1 (serving), WEB-1.8, RUN-1.2
  Tests: config endpoint from vars; headers on HTML and assets; http redirect; dispatcher no longer claims the apex.

- [x] **2. `buildPrompt`**
  Satisfies: WEB-1.6
  Tests: description verbatim (trimmed); both audience texts; connector name; workflow steps present.

- [x] **3. Step flow UI**
  Satisfies: WEB-1.1, WEB-1.2, WEB-1.3, WEB-1.4, WEB-1.5, WEB-1.7
  Tests (component tests with happy-dom): only Claude selectable; Done → form; empty description blocks; length limit; toggle default "only me"; prompt shown and copied; back navigation; no network request carries the description.

- [x] **4. Screenshots** — the operator's Claude screenshots in `public/claude/`, sizes in `CLAUDE_STEPS`. Steps 3–4 (add connector, enable in chat) are text-only until screenshots are provided.
  Satisfies: WEB-1.3

- [x] **5. E2E on dev** (spec 12)
  Flows: `F-WEB-1`.
  Satisfies: E2E-3.3
