import type { ToolAnnotations } from './tool';

type CatalogEntry = { title: string; annotations: ToolAnnotations };

const annotations = (flags: string): ToolAnnotations => ({
  readOnlyHint: flags.includes('R'),
  destructiveHint: flags.includes('D'),
  idempotentHint: flags.includes('I'),
  openWorldHint: flags.includes('O'),
});

/**
 * The tool catalog from specs/04-mcp-server/design.md (MCP-3.1): titles and annotations
 * (R = readOnly, D = destructive, I = idempotent, O = openWorld). Registered tools must match it.
 */
export const TOOL_CATALOG: Record<string, CatalogEntry> = {
  get_platform_guide: { title: 'Read the platform guide', annotations: annotations('RI') },
  whoami: { title: 'Who am I', annotations: annotations('RI') },
  get_usage: { title: 'Show usage and quotas', annotations: annotations('RI') },
  check_slug: { title: 'Check an app address', annotations: annotations('RI') },
  create_app: { title: 'Create an app', annotations: annotations('') },
  retry_provisioning: { title: 'Retry app setup', annotations: annotations('I') },
  list_apps: { title: 'List my apps', annotations: annotations('RI') },
  get_app: { title: 'Show an app', annotations: annotations('RI') },
  delete_app: { title: 'Delete an app', annotations: annotations('D') },
  list_files: { title: 'List app files', annotations: annotations('RI') },
  read_file: { title: 'Read an app file', annotations: annotations('RI') },
  write_files: { title: 'Write app files', annotations: annotations('D') },
  list_deployments: { title: 'List deployments', annotations: annotations('RI') },
  get_deployment: { title: 'Show a deployment', annotations: annotations('RI') },
  redeploy: { title: 'Redeploy the app', annotations: annotations('') },
  rollback: { title: 'Roll back to a deployment', annotations: annotations('') },
  get_logs: { title: 'Show app logs', annotations: annotations('RI') },
  set_secret: { title: 'Set a secret', annotations: annotations('I') },
  list_secrets: { title: 'List secrets', annotations: annotations('RI') },
  delete_secret: { title: 'Delete a secret', annotations: annotations('DI') },
  query_database: { title: 'Query the app database', annotations: annotations('D') },
  list_storage_objects: { title: 'List stored files', annotations: annotations('RI') },
};

/** Rough budget for tools/list (descriptions + schemas), ~12k tokens at ~4 chars/token (MCP non-functional). */
export const TOOLS_LIST_MAX_CHARS = 48_000;
