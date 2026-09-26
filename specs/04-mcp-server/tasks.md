# 04 — MCP Server: Tasks

Depends on: 00. Feature tools are implemented in their own specs; this spec provides the framework, guide and catalog check.

- [x] **1. `McpSession` Durable Object + `/mcp` route**
  agents SDK `McpAgent`, Streamable HTTP, no auth header required.
  Satisfies: MCP-1.1
  Tests (pool-workers): `initialize` without Authorization succeeds and returns `Mcp-Session-Id`; `tools/list` works on that session.

- [x] **2. Tool registry + middleware chain**
  `defineTool`, middleware (track stub, authGuard stub, rateLimit, validateIn, validateOut, serialize).
  Satisfies: MCP-1.3, MCP-1.6, MCP-3.2, MCP-3.3, MCP-3.5, MCP-3.6, MCP-3.7, MCP-3.8, MCP-3.9
  Tests: success has matching `structuredContent` + text; invalid input → `INVALID_INPUT` with paths; thrown `PlatformError` → `isError` result (not JSON-RPC error); unknown exception → `INTERNAL`; bad output → `INTERNAL`; 100 KB cap; middleware order asserted; 121st call/minute → `RATE_LIMITED`.

- [x] **3. Server instructions**
  Satisfies: MCP-2.1
  Tests: `initialize` result contains instructions ≤ 2,000 chars mentioning `get_platform_guide`, `request_login_code`, `write_files`, `get_deployment`.

- [x] **4. Guide assembly + `get_platform_guide`** (content written in spec 06 task 1)
  Satisfies: MCP-2.2, MCP-2.3, MCP-2.4, MCP-2.5
  Tests: every topic returns non-empty Markdown; no unreplaced `{{…}}`; limit values equal `limits.ts`; `contract_version` equals validator version; guide contains the "no templates / you write all files" statement.

- [x] **5. Catalog conformance test**
  Satisfies: MCP-1.2, MCP-1.4, MCP-1.5, MCP-3.1, MCP-3.4
  Tests: registered tools ⊆ catalog (`src/mcp/catalog.ts`, mirrored from the design table) and match its public flag/annotations — equality with the full catalog is asserted by `F-MCP-1` once every feature is implemented; all snake_case; descriptions don't contain "Claude"/"ChatGPT"/"OpenAI"/"Anthropic"; no `org` keys in schemas; annotations match table; total `tools/list` payload under token budget (approx. chars/4 < 12k); `initialize` advertises only the `tools` capability (no resources/prompts required); every tool whose output schema declares `next_step` returns it in its tests.

- [ ] **6. Client compatibility check (manual, before launch)**
  Connect via MCP Inspector, Claude, ChatGPT; run the full journey (login → create → write → deploy → logs).
  Satisfies: MCP non-functional
  Tests: checklist recorded in PR description.

- [x] **7. E2E on dev** — `F-MCP-1` re-asserts full catalog equality once every feature has landed (spec 12)
  Flows: `F-MCP-1`, `F-MCP-2`, `F-MCP-3`.
  Satisfies: E2E-3.3
