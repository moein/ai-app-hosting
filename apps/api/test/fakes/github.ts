import type { GitHubClient, RepoFile, TreeEntry } from '../../src/integrations/github';

type Commit = { sha: string; parent: string | null; files: Map<string, Uint8Array>; message: string };
type Repo = {
  id: number;
  name: string;
  commits: Map<string, Commit>;
  main: string | null;
  dispatches: Record<string, string>[];
};

const encoder = new TextEncoder();
let counter = 0;
const sha = () => (++counter).toString(16).padStart(40, '0');
const treeSha = (files: Map<string, Uint8Array>) =>
  `tree:${[...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => `${path}=${new TextDecoder().decode(bytes)}`)
    .join('|')}`;

/** In-memory GitHub with real commit/tree semantics for tests. */
export function fakeGitHub() {
  const repos = new Map<string, Repo>();
  const blobs = new Map<string, Uint8Array>();
  let repoIds = 1000;
  const failures = new Map<keyof GitHubClient, Error>();
  /** Makes the next updateMain behave as if main moved (race), once. */
  let raceNextUpdate = 0;

  const repo = (name: string) => {
    const found = repos.get(name);
    if (!found) throw new Error(`fake: no repo ${name}`);
    return found;
  };
  const fail = (method: keyof GitHubClient) => {
    const error = failures.get(method);
    if (error) throw error;
  };
  const blobSha = (bytes: Uint8Array) => {
    const id = `blob:${new TextDecoder().decode(bytes)}`;
    blobs.set(id, bytes);
    return id;
  };

  const client: GitHubClient = {
    async createRepo(name) {
      fail('createRepo');
      const existing = repos.get(name);
      if (existing) return { id: existing.id, created: false };
      repos.set(name, { id: ++repoIds, name, commits: new Map(), main: null, dispatches: [] });
      return { id: repoIds, created: true };
    },
    async getRepo(name) {
      const found = repos.get(name);
      return found ? { id: found.id } : null;
    },
    async deleteRepo(name) {
      return repos.delete(name) ? 'deleted' : 'not_found';
    },
    async getHead(name) {
      const r = repo(name);
      if (!r.main) return null;
      return { commitSha: r.main, treeSha: treeSha((r.commits.get(r.main) as Commit).files) };
    },
    async putFileOnEmptyRepo(name, path, content, message) {
      const r = repo(name);
      const commit: Commit = { sha: sha(), parent: null, files: new Map([[path, encoder.encode(content)]]), message };
      r.commits.set(commit.sha, commit);
      r.main = commit.sha;
      return commit.sha;
    },
    async commit(name, change) {
      fail('commit');
      const r = repo(name);
      const parent = r.commits.get(change.parentSha);
      if (!parent) throw new Error('fake: unknown parent');
      const files = new Map(parent.files);
      for (const entry of change.entries as TreeEntry[]) {
        if ('delete' in entry) files.delete(entry.path);
        else if ('content' in entry) files.set(entry.path, encoder.encode(entry.content));
        else
          files.set(
            entry.path,
            Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0)),
          );
      }
      const newTree = treeSha(files);
      if (newTree === treeSha(parent.files)) return { commitSha: parent.sha, treeSha: newTree, changed: false };
      const commit: Commit = { sha: sha(), parent: parent.sha, files, message: change.message };
      r.commits.set(commit.sha, commit);
      return { commitSha: commit.sha, treeSha: newTree, changed: true };
    },
    async updateMain(name, commitSha) {
      const r = repo(name);
      if (raceNextUpdate > 0) {
        raceNextUpdate--;
        return 'not_fast_forward';
      }
      if ((r.commits.get(commitSha) as Commit).parent !== r.main) return 'not_fast_forward';
      r.main = commitSha;
      return 'ok';
    },
    async listTree(name, ref) {
      const r = repos.get(name);
      if (!r) return null;
      const commitSha = ref === 'main' ? r.main : [...r.commits.keys()].find((s) => s.startsWith(ref));
      const commit = commitSha ? r.commits.get(commitSha) : undefined;
      if (!commit) return null;
      const files: RepoFile[] = [...commit.files.entries()].map(([path, bytes]) => ({
        path,
        size: bytes.byteLength,
        sha: blobSha(bytes),
      }));
      return { commitSha: commit.sha, files };
    },
    async readBlob(_name, blob) {
      return blobs.get(blob) ?? new Uint8Array();
    },
    async dispatchWorkflow(name, _workflow, inputs) {
      repo(name).dispatches.push(inputs);
    },
    async getJobLog() {
      return 'fake log';
    },
  };

  return {
    client,
    repos,
    failNext: (method: keyof GitHubClient, error: Error) => failures.set(method, error),
    clearFailures: () => failures.clear(),
    raceNextUpdate: (times = 1) => {
      raceNextUpdate = times;
    },
    /** Files on main as text. */
    mainFiles(name: string): Record<string, string> {
      const r = repo(name);
      const commit = r.main ? r.commits.get(r.main) : undefined;
      return Object.fromEntries(
        [...(commit?.files ?? new Map()).entries()].map(([p, b]) => [p, new TextDecoder().decode(b)]),
      );
    },
    /** Simulates someone else pushing to main (for conflict tests). */
    async pushExternal(name: string, path: string, content: string) {
      const head = await client.getHead(name);
      if (!head) throw new Error('empty repo');
      const c = await client.commit(name, {
        parentSha: head.commitSha,
        baseTreeSha: head.treeSha,
        entries: [{ path, content }],
        message: 'external',
      });
      await client.updateMain(name, c.commitSha);
      return c.commitSha;
    },
  };
}
