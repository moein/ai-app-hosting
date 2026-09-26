import type { ToolAnnotations } from './tool';

type CatalogEntry = { public: boolean; annotations: ToolAnnotations };

const annotations = (flags: string): ToolAnnotations => ({
  readOnlyHint: flags.includes('R'),
  destructiveHint: flags.includes('D'),
  idempotentHint: flags.includes('I'),
  openWorldHint: flags.includes('O'),
});

/**
 * The tool catalog from specs/04-mcp-server/design.md (MCP-3.1): public flag and annotations
 * (R = readOnly, D = destructive, I = idempotent, O = openWorld). Registered tools must match it.
 */
export const TOOL_CATALOG: Record<string, CatalogEntry> = {
  get_platform_guide: { public: true, annotations: annotations('RI') },
  request_login_code: { public: true, annotations: annotations('O') },
  verify_login_code: { public: true, annotations: annotations('') },
  whoami: { public: true, annotations: annotations('RI') },
  logout: { public: false, annotations: annotations('I') },
  get_usage: { public: false, annotations: annotations('RI') },
  check_slug: { public: false, annotations: annotations('RI') },
  create_app: { public: false, annotations: annotations('') },
  retry_provisioning: { public: false, annotations: annotations('I') },
  list_apps: { public: false, annotations: annotations('RI') },
  get_app: { public: false, annotations: annotations('RI') },
  delete_app: { public: false, annotations: annotations('D') },
  list_files: { public: false, annotations: annotations('RI') },
  read_file: { public: false, annotations: annotations('RI') },
  write_files: { public: false, annotations: annotations('D') },
  list_deployments: { public: false, annotations: annotations('RI') },
  get_deployment: { public: false, annotations: annotations('RI') },
  redeploy: { public: false, annotations: annotations('') },
  rollback: { public: false, annotations: annotations('') },
  get_logs: { public: false, annotations: annotations('RI') },
  set_secret: { public: false, annotations: annotations('I') },
  list_secrets: { public: false, annotations: annotations('RI') },
  delete_secret: { public: false, annotations: annotations('DI') },
  query_database: { public: false, annotations: annotations('D') },
};

/** Rough budget for tools/list (descriptions + schemas), ~12k tokens at ~4 chars/token (MCP non-functional). */
export const TOOLS_LIST_MAX_CHARS = 48_000;
