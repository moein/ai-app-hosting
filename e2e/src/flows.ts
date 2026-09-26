import { it } from 'vitest';

/** Flow IDs from the catalog in specs/12-e2e-testing/design.md. */
export type FlowId = `F-${string}-${number}`;

/** Test name tagged with the flow(s) it covers, e.g. "[F-AUTH-1] sign up with a real emailed code" (E2E-3.2). */
export const flow = (ids: FlowId | FlowId[], title: string) =>
  `${[ids]
    .flat()
    .map((id) => `[${id}]`)
    .join('')} ${title}`;

/** `it` for tests tagged slow; they only run with E2E_INCLUDE_SLOW=1 (E2E-1.5). */
export const slowIt = process.env.E2E_INCLUDE_SLOW === '1' ? it : it.skip;
