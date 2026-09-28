/**
 * Everything an app's use costs the platform, per app and UTC day (spec 13 metric catalog).
 * `snapshot` metrics are a level (bytes stored that day); `flow` metrics are totals for the day.
 * `add` metrics are incremented when they happen; the others are recomputed ("replaced") by the hourly collector.
 */
export const USAGE_METRICS = {
  requests: { unit: 'invocations', kind: 'flow', write: 'replace' },
  cpu_ms: { unit: 'ms', kind: 'flow', write: 'replace' },
  asset_requests: { unit: 'requests', kind: 'flow', write: 'replace' },
  d1_rows_read: { unit: 'rows', kind: 'flow', write: 'replace' },
  d1_rows_written: { unit: 'rows', kind: 'flow', write: 'replace' },
  d1_storage_bytes: { unit: 'bytes', kind: 'snapshot', write: 'replace' },
  emails: { unit: 'recipients', kind: 'flow', write: 'add' },
  log_entries: { unit: 'entries', kind: 'flow', write: 'replace' },
  log_bytes: { unit: 'bytes', kind: 'flow', write: 'replace' },
  builds: { unit: 'builds', kind: 'flow', write: 'replace' },
  build_ms: { unit: 'billable ms', kind: 'flow', write: 'replace' },
  deploys: { unit: 'deployments', kind: 'flow', write: 'replace' },
  artifact_bytes: { unit: 'bytes', kind: 'snapshot', write: 'replace' },
} as const;

export type UsageMetric = keyof typeof USAGE_METRICS;
export const USAGE_METRIC_NAMES = Object.keys(USAGE_METRICS) as UsageMetric[];

/** UTC day `YYYY-MM-DD` of an epoch-ms instant. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
