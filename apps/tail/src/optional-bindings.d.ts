// Bindings that wrangler.jsonc declares only once their resource exists, so `wrangler types` can't see them.
// LOG_ARCHIVE: pipeline app-logs-<env>, which needs R2 (spec 10 design, "Archival").
interface OptionalBindings {
  LOG_ARCHIVE?: import('cloudflare:pipelines').Pipeline;
}

interface Env extends OptionalBindings {}

declare namespace Cloudflare {
  interface Env extends OptionalBindings {}
}
