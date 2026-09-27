import { BEING_BUILT_HTML } from '@repo/http';
import type { ScriptMetadata, WorkerModule } from '../integrations/cloudflare';

const BEING_BUILT_INIT = {
  status: 503,
  headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '30' },
} as const;

/** The 503 "being built" response (placeholder script and dispatcher, RUN-1.5 / RUN-2.4). */
export const beingBuiltResponse = () => new Response(BEING_BUILT_HTML, BEING_BUILT_INIT);

/** Platform-owned stand-in uploaded at create_app so secrets can be set before the first deploy (RUN-2.4). */
export const PLACEHOLDER_MODULE: WorkerModule = {
  name: 'placeholder.mjs',
  type: 'esm',
  content: `export default { fetch() { return new Response(${JSON.stringify(BEING_BUILT_HTML)}, ${JSON.stringify(BEING_BUILT_INIT)}); } };`,
};

export const placeholderMetadata = (compatibilityDate: string): ScriptMetadata => ({
  main_module: PLACEHOLDER_MODULE.name,
  compatibility_date: compatibilityDate,
  bindings: [],
  keep_bindings: ['secret_text'],
});
