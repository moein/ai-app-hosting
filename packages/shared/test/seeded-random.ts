import type { Random } from '../src/random';

/** Deterministic Random for tests (mulberry32). */
export function seededRandom(seed = 42): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  return { bytes: (length) => Uint8Array.from({ length }, next) };
}

/** Random that returns bytes from a fixed list, then repeats the last one. */
export function fixedRandom(values: number[]): Random {
  let i = 0;
  return { bytes: (length) => Uint8Array.from({ length }, () => values[Math.min(i++, values.length - 1)] ?? 0) };
}
