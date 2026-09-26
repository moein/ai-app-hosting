import type { FlowId } from './flows';

/**
 * Mirrors the flow catalog in specs/12-e2e-testing/design.md (E2E-3.1). Flip `implemented` to true when the
 * feature lands; the coverage check then requires a test tagged with the flow (E2E-3.2).
 */
export const FLOW_CATALOG: Record<FlowId, { implemented: boolean }> = {
  'F-E2E-1': { implemented: true },
  'F-FND-1': { implemented: true },
  'F-MCP-1': { implemented: false },
  'F-MCP-2': { implemented: false },
  'F-MCP-3': { implemented: false },
  'F-AUTH-1': { implemented: false },
  'F-AUTH-2': { implemented: false },
  'F-AUTH-3': { implemented: false },
  'F-AUTH-4': { implemented: false },
  'F-AUTH-5': { implemented: false },
  'F-SLUG-1': { implemented: false },
  'F-APP-1': { implemented: false },
  'F-APP-2': { implemented: false },
  'F-APP-3': { implemented: false },
  'F-APP-4': { implemented: false },
  'F-SRC-1': { implemented: false },
  'F-SRC-2': { implemented: false },
  'F-DEP-1': { implemented: false },
  'F-DEP-2': { implemented: false },
  'F-DEP-3': { implemented: false },
  'F-DEP-4': { implemented: false },
  'F-DEP-5': { implemented: false },
  'F-RUN-1': { implemented: false },
  'F-RUN-2': { implemented: false },
  'F-RUN-3': { implemented: false },
  'F-LOG-1': { implemented: false },
  'F-MAIL-1': { implemented: false },
  'F-EVT-1': { implemented: false },
};
