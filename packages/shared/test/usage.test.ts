import { describe, expect, it } from 'vitest';
import { estimateCostUsd, PRICES } from '../src/pricing';
import { USAGE_METRIC_NAMES, utcDay } from '../src/usage';

describe('usage catalog and pricing (USG-1.1, USG-2.1)', () => {
  it('prices every catalog metric', () => {
    expect(Object.keys(PRICES.perUnitUsd).sort()).toEqual([...USAGE_METRIC_NAMES].sort());
  });

  it('estimates a known month by hand', () => {
    const cost = estimateCostUsd({
      requests: 1_000_000,
      asset_requests: 1_000_000,
      cpu_ms: 5_000_000,
      d1_rows_written: 1_000_000,
      emails: 1_000,
      build_ms: 60_000 * 10,
    });
    const expected =
      1_000_000 * 0.3e-6 + // requests
      5_000_000 * 0.02e-6 + // cpu
      1.0 + // rows written
      0.1 + // emails
      0.08 + // 10 build minutes
      2_000_000 * 0.8e-6 + // dispatcher + KV per routed request
      1_000_000 * 0.45e-6; // tail + log DO per invocation
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('prorates storage snapshots per day of the month', () => {
    // 1 GB stored for 15 of 30 days = half a GB-month.
    expect(estimateCostUsd({ d1_storage_bytes: 15 * 1e9 }, 30)).toBeCloseTo(0.75 / 2, 10);
    expect(estimateCostUsd({ artifact_bytes: 30 * 1e9 }, 30)).toBeCloseTo(0.015, 10);
  });

  it('formats UTC days', () => {
    expect(utcDay(Date.UTC(2026, 8, 27, 23, 59))).toBe('2026-09-27');
  });
});
