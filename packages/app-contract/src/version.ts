/** App contract version enforced by the validator and shown by the guide (MCP-2.5). */
export const CONTRACT_VERSION = '1';
export const SUPPORTED_CONTRACT_VERSIONS = ['1'] as const;

/** Apps' wrangler.jsonc compatibility_date must fall inside this window (CON-2.4). */
export const COMPATIBILITY_DATE_MIN = '2026-01-01';
export const COMPATIBILITY_DATE_MAX = '2026-08-22';

/** Minimum versions of required packages (CON-2.3). `null` = any version. */
export const REQUIRED_DEPENDENCIES: { name: string; min: string | null; dev: boolean }[] = [
  { name: 'react', min: '19.3.0', dev: false },
  { name: 'react-dom', min: '19.3.0', dev: false },
  { name: 'hono', min: '4.13.0', dev: false },
  { name: 'vite', min: '8.0.0', dev: true },
  { name: '@cloudflare/vite-plugin', min: '1.60.0', dev: true },
  { name: '@vitejs/plugin-react', min: null, dev: true },
  { name: 'typescript', min: null, dev: true },
  { name: '@cloudflare/workers-types', min: null, dev: true },
];
