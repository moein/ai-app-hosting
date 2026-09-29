import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadyApp, deleteApps } from '../src/apps';
import { signIn } from '../src/auth';
import { flow } from '../src/flows';
import { callTool, connect } from '../src/mcp';
import { appName, testEmail } from '../src/run';

let client: Client;
let slug = '';

describe('source files', () => {
  beforeAll(async () => {
    client = await connect((await signIn(testEmail('files'))).accessToken);
    slug = (await createReadyApp(client, appName('files'))).slug;
  });

  afterAll(async () => {
    await deleteApps(client, [slug]);
    await client.close();
  });

  it(flow('F-SRC-1', 'write files without deploying, list and read them back; managed paths are refused'), async () => {
    const written = await callTool<{ commit_sha: string; deployment: unknown; files_changed: number }>(
      client,
      'write_files',
      {
        app: slug,
        message: 'Add notes',
        deploy: false,
        files: [
          { path: 'notes/hello.md', content: '# Hello\n' },
          { path: 'notes/data.bin', content: 'AAEC', encoding: 'base64' },
        ],
      },
    );
    expect(written.ok, JSON.stringify(written)).toBe(true);
    if (!written.ok) return;
    expect(written.data).toMatchObject({ files_changed: 2, deployment: null });

    const listed = await callTool<{ commit_sha: string; files: { path: string; managed: boolean }[] }>(
      client,
      'list_files',
      {
        app: slug,
      },
    );
    expect(listed.ok && listed.data.commit_sha).toBe(written.data.commit_sha);
    expect(listed.ok && listed.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'notes/hello.md', managed: false }),
        expect.objectContaining({ path: 'platform.json', managed: true }),
      ]),
    );

    const text = await callTool<{ content: string; encoding: string }>(client, 'read_file', {
      app: slug,
      path: 'notes/hello.md',
    });
    expect(text.ok && text.data).toMatchObject({ content: '# Hello\n', encoding: 'utf8' });
    const binary = await callTool<{ content: string; encoding: string }>(client, 'read_file', {
      app: slug,
      path: 'notes/data.bin',
    });
    expect(binary.ok && binary.data).toMatchObject({ content: 'AAEC', encoding: 'base64' });

    const managed = await callTool(client, 'write_files', {
      app: slug,
      message: 'Try to edit the workflow',
      files: [{ path: '.github/workflows/deploy.yml', content: 'nope' }],
    });
    expect(!managed.ok && managed.error.code).toBe('PROTECTED_PATH');
  });

  it(flow('F-SRC-2', 'a stale base_commit_sha is rejected with the current head'), async () => {
    const first = await callTool<{ commit_sha: string }>(client, 'write_files', {
      app: slug,
      message: 'v1',
      deploy: false,
      files: [{ path: 'notes/v.txt', content: '1' }],
    });
    const second = await callTool<{ commit_sha: string }>(client, 'write_files', {
      app: slug,
      message: 'v2',
      deploy: false,
      files: [{ path: 'notes/v.txt', content: '2' }],
    });
    if (!first.ok || !second.ok) throw new Error('writes failed');
    const stale = await callTool(client, 'write_files', {
      app: slug,
      message: 'based on v1',
      deploy: false,
      base_commit_sha: first.data.commit_sha,
      files: [{ path: 'notes/v.txt', content: '3' }],
    });
    expect(!stale.ok && stale.error).toMatchObject({
      code: 'COMMIT_CONFLICT',
      details: { head_commit_sha: second.data.commit_sha },
    });
  });
});
