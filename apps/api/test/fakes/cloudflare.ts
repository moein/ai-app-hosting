import type {
  AssetManifest,
  CloudflareClient,
  D1RawResult,
  ScriptMetadata,
  WorkerModule,
} from '../../src/integrations/cloudflare';

type Script = { metadata: ScriptMetadata; modules: WorkerModule[]; secrets: Map<string, string> };

/** In-memory Cloudflare: records every call; D1 queries run against a real local D1 when one is given. */
export function fakeCloudflare(options: { d1?: D1Database } = {}) {
  const calls: { method: keyof CloudflareClient; args: unknown[] }[] = [];
  const databases = new Map<string, string>(); // name → id
  const scripts = new Map<string, Script>();
  const failures = new Map<keyof CloudflareClient, Error>();
  let dbSeq = 0;

  const record = (method: keyof CloudflareClient, args: unknown[]) => {
    calls.push({ method, args });
    const failure = failures.get(method);
    if (failure) throw failure;
  };

  const client: CloudflareClient = {
    async createD1(name) {
      record('createD1', [name]);
      const id = `d1-${++dbSeq}`;
      databases.set(name, id);
      return { id };
    },
    async findD1(name) {
      record('findD1', [name]);
      const id = databases.get(name);
      return id ? { id } : null;
    },
    async deleteD1(id) {
      record('deleteD1', [id]);
      for (const [name, value] of databases) if (value === id) return databases.delete(name) ? 'deleted' : 'not_found';
      return 'not_found';
    },
    async d1Query(dbId, sql, params = []) {
      record('d1Query', [dbId, sql, params]);
      if (!options.d1) return [{ columns: [], rows: [], meta: { rows_read: 0, rows_written: 0, duration: 0 } }];
      const statements = sql
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
      const results: D1RawResult[] = [];
      for (const statement of statements) {
        const prepared = options.d1.prepare(statement).bind(...(statements.length === 1 ? params : []));
        const [columns, ...rows] = (await prepared.raw({ columnNames: true })) as [string[], ...unknown[][]];
        results.push({ columns: columns ?? [], rows, meta: { rows_read: rows.length, rows_written: 0, duration: 1 } });
      }
      return results;
    },
    async uploadScript(name, metadata, modules) {
      record('uploadScript', [name, metadata, modules]);
      const secrets = metadata.keep_bindings?.includes('secret_text')
        ? (scripts.get(name)?.secrets ?? new Map())
        : new Map();
      scripts.set(name, { metadata, modules, secrets });
    },
    async deleteScript(name) {
      record('deleteScript', [name]);
      return scripts.delete(name) ? 'deleted' : 'not_found';
    },
    async createAssetsUploadSession(script, manifest: AssetManifest) {
      record('createAssetsUploadSession', [script, manifest]);
      const hashes = Object.values(manifest).map((entry) => entry.hash);
      return { jwt: 'upload-jwt', buckets: hashes.length ? [hashes] : [] };
    },
    async uploadAssetBucket(uploadJwt, files) {
      record('uploadAssetBucket', [uploadJwt, files]);
      return { jwt: 'completion-jwt' };
    },
    async putSecret(script, name, value) {
      record('putSecret', [script, name]);
      const target = scripts.get(script);
      if (!target) throw new Error(`script ${script} does not exist`);
      target.secrets.set(name, value);
    },
    async deleteSecret(script, name) {
      record('deleteSecret', [script, name]);
      return scripts.get(script)?.secrets.delete(name) ? 'deleted' : 'not_found';
    },
  };

  return {
    client,
    calls,
    databases,
    scripts,
    failNext: (method: keyof CloudflareClient, error: Error) => failures.set(method, error),
    clearFailures: () => failures.clear(),
    callsTo: (method: keyof CloudflareClient) => calls.filter((c) => c.method === method),
  };
}
