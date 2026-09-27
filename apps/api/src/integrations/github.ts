import { Logger, PlatformError } from '@repo/shared';

export type TreeEntry =
  | { path: string; content: string } // UTF-8 text
  | { path: string; base64: string } // binary
  | { path: string; delete: true };

export type RepoFile = { path: string; size: number; sha: string };

/** GitHub operations the platform needs (spec 07 design). A fake backs tests. */
export interface GitHubClient {
  createRepo(name: string, description: string): Promise<{ id: number; created: boolean }>;
  getRepo(name: string): Promise<{ id: number } | null>;
  deleteRepo(name: string): Promise<'deleted' | 'not_found'>;
  /** null = empty repository (no main branch yet). */
  getHead(repo: string): Promise<{ commitSha: string; treeSha: string } | null>;
  putFileOnEmptyRepo(repo: string, path: string, content: string, message: string): Promise<string>;
  /** Builds a tree on top of `baseTreeSha` and a commit on `parentSha`; does not move main. */
  commit(
    repo: string,
    change: { parentSha: string; baseTreeSha: string; entries: TreeEntry[]; message: string },
  ): Promise<{ commitSha: string; treeSha: string; changed: boolean }>;
  updateMain(repo: string, sha: string): Promise<'ok' | 'not_fast_forward'>;
  /** Resolves `ref` (commit SHA or "main") and lists every file. */
  listTree(repo: string, ref: string): Promise<{ commitSha: string; files: RepoFile[] } | null>;
  readBlob(repo: string, sha: string): Promise<Uint8Array>;
  dispatchWorkflow(repo: string, workflow: string, inputs: Record<string, string>): Promise<void>;
  getJobLog(repo: string, jobId: number): Promise<string>;
  getRunJobs(repo: string, runId: number): Promise<{ id: number; name: string; conclusion: string | null }[]>;
}

const API = 'https://api.github.com';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const fromBase64 = (value: string) => Uint8Array.from(atob(value.replace(/\s/g, '')), (c) => c.charCodeAt(0));

/** RS256 app JWT (spec 07 design): iat 60 s in the past, 9 minute lifetime. */
export async function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const pem = privateKeyPem.replace(/\\n/g, '\n');
  const der = fromBase64(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/** Installation tokens, cached per scope in the isolate until 5 minutes before expiry (SRC-4.2). */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function createGitHubClient(options: {
  appId: string;
  privateKey: string;
  installationId: string;
  org: string;
  fetch?: typeof fetch;
  now?: () => number;
}): GitHubClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; auth: string; allow?: number[] },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(`${API}${path}`, {
        method,
        headers: {
          authorization: init.auth,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ai-app-hosting',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new PlatformError('UPSTREAM_ERROR', { message: 'Could not reach GitHub.', cause: error });
    }
    if (response.ok || init.allow?.includes(response.status)) return response;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
    if (rateLimited || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new PlatformError('UPSTREAM_ERROR', {
        message: 'GitHub is temporarily unavailable.',
        ...(retryAfter > 0 ? { details: { retry_after_seconds: retryAfter } } : {}),
      });
    }
    const body = (await response.text()).slice(0, 500);
    Logger.root.error('github api error', { method, path, status: response.status, body });
    throw new PlatformError('INTERNAL', { message: `GitHub rejected ${method} ${path} (${response.status}).` });
  }

  async function installationToken(repo?: string): Promise<string> {
    const cacheKey = `${options.installationId}:${repo ?? '*'}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;
    const jwt = await signAppJwt(options.appId, options.privateKey, now());
    const response = await request('POST', `/app/installations/${options.installationId}/access_tokens`, {
      auth: `Bearer ${jwt}`,
      ...(repo ? { body: { repositories: [repo] } } : {}),
    });
    const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
    tokenCache.set(cacheKey, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  /** Per-repo calls use a token scoped to that repository only (SRC-4.1). */
  const repoCall = async (method: string, repo: string, path: string, body?: unknown, allow?: number[]) =>
    request(method, `/repos/${options.org}/${repo}${path}`, {
      auth: `Bearer ${await installationToken(repo)}`,
      ...(body === undefined ? {} : { body }),
      ...(allow ? { allow } : {}),
    });
  const json = async <T>(response: Response) => (await response.json()) as T;

  const client: GitHubClient = {
    async createRepo(name, description) {
      const response = await request('POST', `/orgs/${options.org}/repos`, {
        auth: `Bearer ${await installationToken()}`,
        body: {
          name,
          description,
          private: true,
          has_issues: false,
          has_wiki: false,
          has_projects: false,
          auto_init: false,
        },
        allow: [422],
      });
      if (response.status === 422) {
        const existing = await client.getRepo(name);
        if (!existing) throw new PlatformError('INTERNAL', { message: `Could not create repository ${name}.` });
        return { id: existing.id, created: false };
      }
      return { id: (await json<{ id: number }>(response)).id, created: true };
    },

    async getRepo(name) {
      const response = await request('GET', `/repos/${options.org}/${name}`, {
        auth: `Bearer ${await installationToken()}`,
        allow: [404],
      });
      return response.status === 404 ? null : { id: (await json<{ id: number }>(response)).id };
    },

    async deleteRepo(name) {
      const response = await request('DELETE', `/repos/${options.org}/${name}`, {
        auth: `Bearer ${await installationToken()}`,
        allow: [404],
      });
      return response.status === 404 ? 'not_found' : 'deleted';
    },

    async getHead(repo) {
      const ref = await repoCall('GET', repo, '/git/ref/heads/main', undefined, [404, 409]);
      if (ref.status !== 200) return null;
      const commitSha = (await json<{ object: { sha: string } }>(ref)).object.sha;
      const commit = await json<{ tree: { sha: string } }>(await repoCall('GET', repo, `/git/commits/${commitSha}`));
      return { commitSha, treeSha: commit.tree.sha };
    },

    async putFileOnEmptyRepo(repo, path, content, message) {
      const response = await repoCall('PUT', repo, `/contents/${path}`, {
        message,
        content: toBase64(encoder.encode(content)),
        branch: 'main',
      });
      return (await json<{ commit: { sha: string } }>(response)).commit.sha;
    },

    async commit(repo, change) {
      const tree = await Promise.all(
        change.entries.map(async (entry) => {
          if ('delete' in entry) return { path: entry.path, mode: '100644', type: 'blob', sha: null };
          if ('content' in entry) return { path: entry.path, mode: '100644', type: 'blob', content: entry.content };
          const blob = await json<{ sha: string }>(
            await repoCall('POST', repo, '/git/blobs', { content: entry.base64, encoding: 'base64' }),
          );
          return { path: entry.path, mode: '100644', type: 'blob', sha: blob.sha };
        }),
      );
      const newTree = await json<{ sha: string }>(
        await repoCall('POST', repo, '/git/trees', { base_tree: change.baseTreeSha, tree }),
      );
      if (newTree.sha === change.baseTreeSha)
        return { commitSha: change.parentSha, treeSha: newTree.sha, changed: false };
      const commit = await json<{ sha: string }>(
        await repoCall('POST', repo, '/git/commits', {
          message: change.message,
          tree: newTree.sha,
          parents: [change.parentSha],
        }),
      );
      return { commitSha: commit.sha, treeSha: newTree.sha, changed: true };
    },

    async updateMain(repo, sha) {
      const response = await repoCall('PATCH', repo, '/git/refs/heads/main', { sha, force: false }, [422]);
      return response.status === 422 ? 'not_fast_forward' : 'ok';
    },

    async listTree(repo, ref) {
      const commitResponse = await repoCall(
        'GET',
        repo,
        `/commits/${encodeURIComponent(ref)}`,
        undefined,
        [404, 409, 422],
      );
      if (commitResponse.status !== 200) return null;
      const commit = await json<{ sha: string; commit: { tree: { sha: string } } }>(commitResponse);
      const tree = await json<{ tree: { path: string; type: string; size?: number; sha: string }[] }>(
        await repoCall('GET', repo, `/git/trees/${commit.commit.tree.sha}?recursive=1`),
      );
      return {
        commitSha: commit.sha,
        files: tree.tree
          .filter((entry) => entry.type === 'blob')
          .map((entry) => ({ path: entry.path, size: entry.size ?? 0, sha: entry.sha })),
      };
    },

    async readBlob(repo, sha) {
      const blob = await json<{ content: string }>(await repoCall('GET', repo, `/git/blobs/${sha}`));
      return fromBase64(blob.content);
    },

    async dispatchWorkflow(repo, workflow, inputs) {
      await repoCall('POST', repo, `/actions/workflows/${workflow}/dispatches`, { ref: 'main', inputs });
    },

    async getJobLog(repo, jobId) {
      return (await repoCall('GET', repo, `/actions/jobs/${jobId}/logs`)).text();
    },

    async getRunJobs(repo, runId) {
      const body = await json<{ jobs: { id: number; name: string; conclusion: string | null }[] }>(
        await repoCall('GET', repo, `/actions/runs/${runId}/jobs`),
      );
      return body.jobs.map(({ id, name, conclusion }) => ({ id, name, conclusion }));
    },
  };
  return client;
}

/** Test hook: forget cached installation tokens. */
export const clearGitHubTokenCache = () => tokenCache.clear();
