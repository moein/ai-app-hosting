import { PlatformError } from '@repo/shared';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** LOG-3.2: an ISO 8601 timestamp or a relative duration (`15m`, `2h`, `1d`) before `now`. */
export function parseTimeArg(value: string, now: number, field: string): number {
  const relative = /^(\d{1,6})([mhd])$/.exec(value.trim());
  if (relative) return now - Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
  const ms = ISO.test(value.trim()) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    const message = 'Use an ISO 8601 timestamp or a duration like 15m, 2h, 1d.';
    throw new PlatformError('INVALID_INPUT', {
      message: `${field}: ${message}`,
      details: { issues: [{ path: [field], message }] },
    });
  }
  return ms;
}
