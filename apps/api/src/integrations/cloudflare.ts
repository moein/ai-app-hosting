import { Logger, PlatformError } from '@repo/shared';

export type WorkerModule = { name: string; content: string | Uint8Array; type: 'esm' | 'text' | 'data' | 'wasm' };

export type WorkerBinding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'assets'; name: string }
  | { type: 'service'; name: string; service: string; entrypoint?: string; props?: Record<string, unknown> }
  | { type: 'plain_text'; name: string; text: string };

export type ScriptMetadata = {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: WorkerBinding[];
  keep_bindings?: string[];
  assets?: { jwt: string; config?: Record<string, unknown> };
  tail_consumers?: { service: string }[];
  tags?: string[];
};

export type AssetManifest = Record<string, { hash: string; size: number }>;
export type D1RawResult = {
  columns: string[];
  rows: unknown[][];
  meta: { rows_read: number; rows_written: number; duration: number };
};

/** Cloudflare REST operations the api worker needs at runtime (spec 09 design). A fake backs tests. */
export interface CloudflareClient {
  createD1(name: string): Promise<{ id: string }>;
  findD1(name: string): Promise<{ id: string } | null>;
  deleteD1(id: string): Promise<'deleted' | 'not_found'>;
  /** Runs one or more statements; returns one raw result per statement. */
  d1Query(dbId: string, sql: string, params?: unknown[]): Promise<D1RawResult[]>;
  uploadScript(name: string, metadata: ScriptMetadata, modules: WorkerModule[]): Promise<void>;
  deleteScript(name: string): Promise<'deleted' | 'not_found'>;
  createAssetsUploadSession(script: string, manifest: AssetManifest): Promise<{ jwt: string; buckets: string[][] }>;
  /** Uploads one bucket (base64 contents keyed by hash); the last bucket returns the completion token. */
  uploadAssetBucket(
    uploadJwt: string,
    files: Record<string, { base64: string; contentType: string }>,
  ): Promise<{ jwt?: string }>;
  putSecret(script: string, name: string, value: string): Promise<void>;
  deleteSecret(script: string, name: string): Promise<'deleted' | 'not_found'>;
}

type Envelope<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

const API = 'https://api.cloudflare.com/client/v4';

export function createCloudflareClient(options: {
  apiToken: string;
  accountId: string;
  dispatchNamespace: string;
  fetch?: typeof fetch;
}): CloudflareClient {
  const doFetch = options.fetch ?? fetch;
  const account = `${API}/accounts/${options.accountId}`;
  const scripts = `${account}/workers/dispatch/namespaces/${options.dispatchNamespace}/scripts`;

  async function call<T>(
    method: string,
    url: string,
    body?: unknown,
    init: { auth?: string; allowNotFound?: boolean } = {},
  ): Promise<T | 'not_found'> {
    const headers: Record<string, string> = { authorization: init.auth ?? `Bearer ${options.apiToken}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await doFetch(url, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    } catch (error) {
      throw new PlatformError('UPSTREAM_ERROR', { message: 'Could not reach Cloudflare.', cause: error });
    }
    if (response.status === 404 && init.allowNotFound) return 'not_found';
    const text = await response.text();
    const envelope = (text ? JSON.parse(text) : {}) as Envelope<T>;
    if (response.ok && envelope.success !== false) return envelope.result;
    if (response.status === 429 || response.status >= 500) {
      throw new PlatformError('UPSTREAM_ERROR', { message: 'Cloudflare is temporarily unavailable.' });
    }
    Logger.root.error('cloudflare api error', {
      method,
      path: url.replace(API, ''),
      status: response.status,
      errors: envelope.errors,
    });
    throw new PlatformError('UPSTREAM_ERROR', {
      message: `Cloudflare rejected the request: ${envelope.errors?.map((e) => e.message).join('; ') ?? response.status}`,
      hint: 'Retry; if it keeps failing, tell the user the platform has a configuration problem.',
    });
  }

  const unwrap = <T>(value: T | 'not_found'): T => {
    if (value === 'not_found') throw new PlatformError('NOT_FOUND');
    return value;
  };

  return {
    async createD1(name) {
      const result = unwrap(await call<{ uuid: string }>('POST', `${account}/d1/database`, { name }));
      return { id: result.uuid };
    },
    async findD1(name) {
      const list = unwrap(
        await call<{ uuid: string; name: string }[]>('GET', `${account}/d1/database?name=${encodeURIComponent(name)}`),
      );
      const match = list.find((db) => db.name === name);
      return match ? { id: match.uuid } : null;
    },
    async deleteD1(id) {
      const result = await call('DELETE', `${account}/d1/database/${id}`, undefined, { allowNotFound: true });
      return result === 'not_found' ? 'not_found' : 'deleted';
    },
    async d1Query(dbId, sql, params = []) {
      const results = unwrap(
        await call<{ results: { columns: string[]; rows: unknown[][] }; meta: D1RawResult['meta'] }[]>(
          'POST',
          `${account}/d1/database/${dbId}/raw`,
          { sql, params },
        ),
      );
      return results.map((r) => ({ columns: r.results?.columns ?? [], rows: r.results?.rows ?? [], meta: r.meta }));
    },
    async uploadScript(name, metadata, modules) {
      const form = new FormData();
      form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      const types = {
        esm: 'application/javascript+module',
        text: 'text/plain',
        data: 'application/octet-stream',
        wasm: 'application/wasm',
      } as const;
      for (const module of modules) {
        form.set(module.name, new File([module.content], module.name, { type: types[module.type] }));
      }
      unwrap(await call('PUT', `${scripts}/${name}`, form));
    },
    async deleteScript(name) {
      const result = await call('DELETE', `${scripts}/${name}?force=true`, undefined, { allowNotFound: true });
      return result === 'not_found' ? 'not_found' : 'deleted';
    },
    async createAssetsUploadSession(script, manifest) {
      const result = unwrap(
        await call<{ jwt: string; buckets?: string[][] }>('POST', `${scripts}/${script}/assets-upload-session`, {
          manifest,
        }),
      );
      return { jwt: result.jwt, buckets: result.buckets ?? [] };
    },
    async uploadAssetBucket(uploadJwt, files) {
      const form = new FormData();
      for (const [hash, file] of Object.entries(files)) {
        form.set(hash, new File([file.base64], hash, { type: file.contentType }));
      }
      const result = unwrap(
        await call<{ jwt?: string } | null>('POST', `${account}/workers/assets/upload?base64=true`, form, {
          auth: `Bearer ${uploadJwt}`,
        }),
      );
      return result?.jwt ? { jwt: result.jwt } : {};
    },
    async putSecret(script, name, value) {
      unwrap(await call('PUT', `${scripts}/${script}/secrets`, { name, text: value, type: 'secret_text' }));
    },
    async deleteSecret(script, name) {
      const result = await call('DELETE', `${scripts}/${script}/secrets/${encodeURIComponent(name)}`, undefined, {
        allowNotFound: true,
      });
      return result === 'not_found' ? 'not_found' : 'deleted';
    },
  };
}
