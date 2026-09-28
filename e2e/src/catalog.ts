import type { FlowId } from './flows';

/**
 * Mirrors the flow catalog in specs/12-e2e-testing/design.md (E2E-3.1). Flip `implemented` to true when the
 * feature lands; the coverage check then requires a test tagged with the flow (E2E-3.2).
 */
export const FLOW_CATALOG: Record<FlowId, { implemented: boolean }> = {
  'F-E2E-1': { implemented: true },
  'F-FND-1': { implemented: true },
  'F-MCP-1': { implemented: true },
  'F-MCP-2': { implemented: true },
  'F-MCP-3': { implemented: true },
  'F-AUTH-1': { implemented: true },
  'F-AUTH-2': { implemented: true },
  'F-AUTH-3': { implemented: true },
  'F-AUTH-4': { implemented: true },
  'F-AUTH-5': { implemented: true },
  'F-SLUG-1': { implemented: true },
  'F-APP-1': { implemented: true },
  'F-APP-2': { implemented: true },
  'F-APP-3': { implemented: true },
  'F-APP-4': { implemented: true },
  'F-SRC-1': { implemented: true },
  'F-SRC-2': { implemented: true },
  'F-DEP-1': { implemented: true },
  'F-DEP-2': { implemented: true },
  'F-DEP-3': { implemented: true },
  'F-DEP-4': { implemented: true },
  'F-DEP-5': { implemented: true },
  'F-RUN-1': { implemented: true },
  'F-RUN-2': { implemented: true },
  'F-RUN-3': { implemented: true },
  'F-RUN-4': { implemented: true },
  'F-LOG-1': { implemented: true },
  'F-MAIL-1': { implemented: true },
  'F-EVT-1': { implemented: false },
  'F-USG-1': { implemented: false },
};

/** Tests of flows not marked implemented are skipped, so a blocked feature doesn't fail every deploy. */
export const isImplemented = (id: FlowId) => FLOW_CATALOG[id]?.implemented === true;
