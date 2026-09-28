import type { UsageMetric } from './usage';

/**
 * List prices in USD after included allowances (spec 13, USG-2.1). Allowances are account-wide, so per-app
 * estimates ignore them and are an upper bound. Verify against the providers' pricing pages and bump `asOf`
 * whenever a number changes.
 */
export const PRICES = {
  asOf: '2026-09-27',
  /** Per unit of each flow metric; per byte-month for snapshot metrics. */
  perUnitUsd: {
    requests: 0.3e-6, // Workers for Platforms requests
    cpu_ms: 0.02e-6, // Workers for Platforms CPU time
    asset_requests: 0, // static asset requests are free (overhead below still applies)
    d1_rows_read: 0.001e-6,
    d1_rows_written: 1.0e-6,
    d1_storage_bytes: 0.75 / 1e9, // per GB-month
    emails: 0.1e-3, // SES, per recipient
    log_entries: 2.0e-6, // AppLogBuffer SQLite writes (row + index)
    log_bytes: 0, // bounded buffer; archive storage is negligible
    builds: 0, // priced through build_ms
    build_ms: 0.008 / 60_000, // GitHub Actions Linux, private repos
    deploys: 0,
    artifact_bytes: 0.015 / 1e9, // R2 Standard, per GB-month
  } satisfies Record<UsageMetric, number>,
  /** Platform work behind every routed request (requests + asset_requests): dispatcher invocation + KV route read. */
  perRoutedRequestUsd: 0.3e-6 + 0.5e-6,
  /** Platform work behind every app invocation (requests): tail worker invocation + log buffer DO request. */
  perInvocationUsd: 0.3e-6 + 0.15e-6,
};

const SNAPSHOT = new Set<UsageMetric>(['d1_storage_bytes', 'artifact_bytes']);

/**
 * Estimated cost of usage totals over a period. Flow metrics are summed over the period; snapshot metrics are
 * the sum of their daily snapshots, prorated per GB-month with `daysInMonth`.
 */
export function estimateCostUsd(totals: Partial<Record<UsageMetric, number>>, daysInMonth = 30): number {
  let cost = 0;
  for (const [metric, quantity] of Object.entries(totals) as [UsageMetric, number][]) {
    const unit = PRICES.perUnitUsd[metric] ?? 0;
    cost += SNAPSHOT.has(metric) ? (quantity / daysInMonth) * unit : quantity * unit;
  }
  const requests = totals.requests ?? 0;
  cost += (requests + (totals.asset_requests ?? 0)) * PRICES.perRoutedRequestUsd;
  cost += requests * PRICES.perInvocationUsd;
  return cost;
}
