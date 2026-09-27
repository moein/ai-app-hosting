// Bindings that wrangler.jsonc declares only once their resource exists, so `wrangler types` can't see them.
// METRICS: Analytics Engine dataset platform_metrics_<env>, once Analytics Engine is enabled on the account.
interface OptionalBindings {
  METRICS?: AnalyticsEngineDataset;
}

interface Env extends OptionalBindings {}

declare namespace Cloudflare {
  interface Env extends OptionalBindings {}
}
