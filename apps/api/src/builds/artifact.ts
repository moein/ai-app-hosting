import { PlatformError } from '@repo/shared';
import type { WorkerModule } from '../integrations/cloudflare';

const decoder = new TextDecoder();

export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const cString = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};
const octal = (bytes: Uint8Array) => Number.parseInt(cString(bytes).trim() || '0', 8);

/** Minimal tar reader (ustar + GNU long names + pax `path`), enough for `tar czf` output (spec 08). */
export function untar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = cString(header.subarray(345, 500));
    let name = cString(header.subarray(0, 100));
    if (prefix) name = `${prefix}/${name}`;
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(decoder.decode(data))?.[1];
      if (path) longName = path;
      continue;
    }
    const path = (longName ?? name).replace(/^\.\//, '');
    longName = undefined;
    if (type === '0' || type === '\0') files.set(path, data.slice());
  }
  return files;
}

export type ArtifactConfig = {
  compatibility_date: string;
  compatibility_flags: string[];
  vars: Record<string, string>;
  assets: { not_found_handling?: string; run_worker_first?: string[] | boolean };
};

export type Artifact = {
  mainModule: string;
  modules: WorkerModule[];
  /** "/index.html" → bytes */
  assets: Map<string, Uint8Array>;
  migrations: { name: string; sql: string }[];
  config: ArtifactConfig;
};

const buildFailed = (message: string) => new PlatformError('BUILD_FAILED', { message, details: { step: 'package' } });
const DEFAULT_EXPORT = /export\s+default\b|export\s*\{[^}]*\bas\s+default\b[^}]*\}/;

/** Checks the artifact's structure and extracts what deploying needs (DEP-2.6). */
export function inspectArtifact(files: Map<string, Uint8Array>): Artifact {
  const configBytes = files.get('dist/app/wrangler.json');
  if (!configBytes)
    throw buildFailed('The build output has no dist/app/wrangler.json (is the Cloudflare Vite plugin configured?).');
  const config = JSON.parse(decoder.decode(configBytes)) as Partial<ArtifactConfig> & { main?: string };
  const mainPath = `dist/app/${config.main ?? ''}`;
  const main = files.get(mainPath);
  if (!config.main || !main) throw buildFailed(`The build output has no main module ${mainPath}.`);
  if (!DEFAULT_EXPORT.test(decoder.decode(main))) {
    throw buildFailed('src/api/index.ts must default-export the Hono app (CON-2.7).');
  }
  if (![...files.keys()].some((path) => path.startsWith('dist/client/'))) {
    throw buildFailed('The build output has no dist/client/ (static assets).');
  }

  const modules: WorkerModule[] = [...files.entries()]
    .filter(([path]) => path.startsWith('dist/app/') && !path.startsWith('dist/app/.vite/') && /\.m?js$/.test(path))
    .map(([path, content]) => ({ name: path.slice('dist/app/'.length), type: 'esm' as const, content }));
  const assets = new Map(
    [...files.entries()]
      .filter(([path]) => path.startsWith('dist/client/'))
      .map(([path, content]) => [path.slice('dist/client'.length), content] as const),
  );
  const migrations = [...files.entries()]
    .filter(([path]) => /^migrations\/[^/]+\.sql$/.test(path))
    .map(([path, content]) => ({ name: path.slice('migrations/'.length), sql: decoder.decode(content) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    mainModule: config.main,
    modules,
    assets,
    migrations,
    config: {
      compatibility_date: config.compatibility_date ?? '',
      compatibility_flags: config.compatibility_flags ?? [],
      vars: Object.fromEntries(Object.entries(config.vars ?? {}).filter(([, v]) => typeof v === 'string')) as Record<
        string,
        string
      >,
      assets: config.assets ?? {},
    },
  };
}
