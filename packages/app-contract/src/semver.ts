/** Lowest version allowed by a simple range (`1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`), or null if unpinned. */
export function minimumVersion(range: string): [number, number, number] | null {
  const match = /^\s*(?:\^|~|>=|=)?\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$/.exec(range);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) - (b[i] as number);
  return 0;
}

export const parseVersion = (version: string) => minimumVersion(version) as [number, number, number];
