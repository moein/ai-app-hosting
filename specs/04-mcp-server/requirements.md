# 04 — MCP Server: Requirements

The remote MCP server is the product's only interface. It must work with any MCP-capable AI client and must teach that AI everything it needs to write, ship and operate an app, because the platform itself never writes app code.

## Stories & acceptance criteria

### MCP-1 — Client-agnostic protocol surface
As a user of any AI assistant (Claude, ChatGPT, others), I want to connect the platform by pasting one URL, so that I can use the assistant I already have.

- **MCP-1.1** THE SYSTEM SHALL serve MCP over Streamable HTTP at `PLATFORM_API_ORIGIN/mcp`, protected by OAuth 2.1 bearer tokens per the MCP authorization spec (spec 02, AUTH-4).
- **MCP-1.2** THE SYSTEM SHALL rely only on MCP tools and the `instructions` field of the initialize result; it SHALL NOT require resources, prompts, sampling, elicitation, roots or any client-specific extension for any user journey.
- **MCP-1.3** THE SYSTEM SHALL return every successful tool result both as `structuredContent` conforming to the tool's declared `outputSchema` and as a single text content block containing the same JSON.
- **MCP-1.4** THE SYSTEM SHALL name tools in `snake_case` and SHALL write tool descriptions that are self-contained and never refer to a specific AI product.
- **MCP-1.5** THE SYSTEM SHALL NOT expose organization identifiers in any tool input or output (APP-1.4).
- **MCP-1.6** THE SYSTEM SHALL give every tool a human-readable `title` and set MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) as listed in design.md.

### MCP-2 — Teaching the AI what to ship
As an AI client, I want precise instructions from the server, so that the code I write builds and runs on the first try.

- **MCP-2.1** THE SYSTEM SHALL include server `instructions` (≤ 2,000 characters) stating: the AI writes all code; how to log the user in; to call `get_platform_guide` before writing any code; and the write → deploy → verify loop.
- **MCP-2.2** WHEN `get_platform_guide({ topic? })` is called THE SYSTEM SHALL return Markdown for the requested topic (`all` by default; also `workflow`, `contract`, `database`, `email`, `secrets`, `limits`, `troubleshooting`) and the `contract_version`.
- **MCP-2.3** THE SYSTEM SHALL build the guide from a single source (`packages/app-contract/guide/`) with numeric limits interpolated from `limits.ts`, so the guide can never disagree with enforced limits.
- **MCP-2.4** THE SYSTEM SHALL state in the guide that the platform provides no templates or generated code and that the AI must create every file (other than managed files) itself.
- **MCP-2.5** THE SYSTEM SHALL keep `contract_version` in the guide identical to the version enforced by the contract validator (spec 06).

### MCP-3 — Tool behavior
As an AI client, I want consistent, recoverable tool behavior, so that I can drive long tasks without a human debugging for me.

- **MCP-3.1** THE SYSTEM SHALL expose exactly the tool catalog in design.md.
- **MCP-3.2** WHEN tool input fails schema validation THE SYSTEM SHALL return `INVALID_INPUT` with `details.issues: [{ path, message }]`.
- **MCP-3.3** WHEN a tool fails THE SYSTEM SHALL return a tool result with `isError: true` whose content is the `PlatformError` JSON (`code`, `message`, `hint`, `retryable`, `details`) — not a JSON-RPC protocol error. The error result carries the JSON as a text content block only, with no `structuredContent`: MCP client SDKs validate `structuredContent` against the tool's `outputSchema` even for error results, so an error envelope there would surface as a protocol error and hide the `hint`.
- **MCP-3.4** WHEN a successful result implies a follow-up action THE SYSTEM SHALL include a `next_step` string describing it.
- **MCP-3.5** THE SYSTEM SHALL complete every tool call within 30 seconds; operations that take longer SHALL return current state plus a `next_step` to poll.
- **MCP-3.6** THE SYSTEM SHALL cap every tool result at 100 KB of JSON; truncated fields SHALL be marked (`truncated: true`) with guidance on how to fetch the rest.
- **MCP-3.7** THE SYSTEM SHALL run every tool call through the same middleware chain: tracking (spec 05) → auth guard (spec 02) → per-user rate limit → input validation → handler → output validation.
- **MCP-3.8** IF an authenticated user makes more than `TOOL_CALLS_PER_USER_PER_MINUTE` calls in a minute THEN THE SYSTEM SHALL return `RATE_LIMITED` with `details.retry_after_seconds`.
- **MCP-3.9** IF a handler's output fails its output schema THEN THE SYSTEM SHALL return `INTERNAL` and log the schema issues.

## Non-functional requirements

- Cold `initialize` + `tools/list` p95 < 500 ms.
- Tool descriptions + input schemas together stay under ~12k tokens so they fit comfortably in any client's context.
- Tested against the official MCP Inspector and at least two real clients (Claude, ChatGPT) before launch.

## Out of scope

- MCP resources, prompts, sampling, elicitation (may be added later as optional enhancements, never required).
- stdio transport / local MCP server.
- SSE-only legacy transport (add only if a target client requires it).
