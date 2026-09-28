import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadyApp, deleteApps } from '../src/apps';
import { logIn } from '../src/auth';
import { fixtureFiles, writeAndDeploy } from '../src/deploy';
import { flow } from '../src/flows';
import { connect } from '../src/mcp';
import { appName, testEmail } from '../src/run';

let client: Client;
let slug = '';

describe('failed builds', () => {
  beforeAll(async () => {
    client = await connect();
    await logIn(client, testEmail('build-fail'));
    slug = (await createReadyApp(client, appName('build-fail'))).slug;
  });

  afterAll(async () => {
    await deleteApps(client, [slug]);
    await client.close();
  });

  it(flow('F-DEP-2', 'a contract violation fails validation with the violated rules'), async () => {
    const deployment = await writeAndDeploy(
      client,
      slug,
      fixtureFiles({ 'wrangler.toml': 'name = "not-allowed"\n' }),
      'Add a forbidden file',
    );
    expect(deployment, JSON.stringify(deployment)).toMatchObject({
      status: 'failed',
      error: { code: 'CONTRACT_VIOLATION' },
    });
    expect(deployment.error?.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'CON-R14', path: 'wrangler.toml' })]),
    );
  });

  it(flow('F-DEP-3', 'a TypeScript error fails the build with the parsed error location'), async () => {
    const source = fixtureFiles().find((f) => f.path === 'src/api/index.ts')?.content ?? '';
    const broken = source.replace('const app = new Hono', "const notANumber: number = 'text';\nconst app = new Hono");
    const deployment = await writeAndDeploy(
      client,
      slug,
      [
        { path: 'wrangler.toml', op: 'delete' },
        { path: 'src/api/index.ts', content: broken },
      ],
      'Introduce a type error',
    );
    expect(deployment, JSON.stringify(deployment)).toMatchObject({ status: 'failed', error: { code: 'BUILD_FAILED' } });
    expect(deployment.error?.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'typescript', file: 'src/api/index.ts' })]),
    );
  });
});
