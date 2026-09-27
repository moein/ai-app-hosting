// Bindings that wrangler.jsonc declares only once their resource exists, so `wrangler types` can't see them.
// EVENTS: stream mcp-events-<env>, which needs R2 (spec 05 task 1). Until then events are skipped.
interface OptionalBindings {
  EVENTS?: import('cloudflare:pipelines').Pipeline<import('@repo/shared').McpEvent>;
}

interface Env extends OptionalBindings {}

declare namespace Cloudflare {
  interface Env extends OptionalBindings {}
}
