import { PlatformError } from './errors';

export interface Clock {
  /** Epoch milliseconds (UTC). */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION = /^(\d{1,6})([smhd])$/;

/** Parses relative durations like `30s`, `15m`, `2h`, `1d` into milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  const amount = match?.[1];
  const unit = match?.[2] as keyof typeof UNIT_MS | undefined;
  if (amount === undefined || unit === undefined) {
    throw new PlatformError('INVALID_INPUT', {
      message: `Invalid duration "${input}".`,
      details: { issues: [{ path: [], message: 'Use a number followed by s, m, h or d, e.g. 15m.' }] },
    });
  }
  return Number(amount) * UNIT_MS[unit];
}
