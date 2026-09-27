import { describe, expect, it } from 'vitest';
import { gunzip, inspectArtifact, untar } from '../../src/builds/artifact';
import { artifactFiles, gzip, makeTar } from './tar';

const read = async (files: Record<string, string>) => inspectArtifact(untar(await gunzip(await gzip(makeTar(files)))));

describe('artifact reader (DEP-2.6)', () => {
  it('extracts modules, assets, migrations and config from a tar.gz build', async () => {
    const artifact = await read(artifactFiles());
    expect(artifact.mainModule).toBe('index.js');
    expect(artifact.modules.map((m) => m.name).sort()).toEqual(['chunk.js', 'index.js']);
    expect([...artifact.assets.keys()].sort()).toEqual(['/assets/app.js', '/index.html']);
    expect(artifact.migrations.map((m) => m.name)).toEqual(['0001_init.sql']);
    expect(artifact.config).toMatchObject({ compatibility_date: '2026-08-22', vars: { GREETING: 'hi' } });
  });

  it('handles GNU long names', async () => {
    const long = `./dist/client/${'deep/'.repeat(25)}file.css`;
    const artifact = await read({ ...artifactFiles(), [long]: 'a{}' });
    expect([...artifact.assets.keys()].some((path) => path.endsWith('/file.css') && path.length > 100)).toBe(true);
  });

  it.each([
    ['no generated wrangler.json', { './dist/app/wrangler.json': null }],
    ['no main module', { './dist/app/index.js': null }],
    ['no default export', { './dist/app/index.js': 'export const x = 1;' }],
    ['no client assets', { './dist/client/index.html': null, './dist/client/assets/app.js': null }],
  ])('fails with BUILD_FAILED when there is %s', async (_, overrides) => {
    await expect(read(artifactFiles(overrides as Record<string, string | null>))).rejects.toMatchObject({
      code: 'BUILD_FAILED',
    });
  });
});
