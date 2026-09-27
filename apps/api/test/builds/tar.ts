const encoder = new TextEncoder();

function header(name: string, size: number, type = '0'): Uint8Array {
  const h = new Uint8Array(512);
  const write = (value: string, offset: number, length: number) =>
    h.set(encoder.encode(value).subarray(0, length), offset);
  write(name.length > 100 ? name.slice(-100) : name, 0, 100);
  write('0000644\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  write('00000000000\0', 136, 12);
  write('        ', 148, 8);
  write(type, 156, 1);
  write('ustar\u000000', 257, 8);
  const checksum = h.reduce((sum, b) => sum + b, 0);
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

const pad = (data: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};

/** ustar archive; names over 100 chars use a GNU "L" long-name entry, like GNU tar. */
export function makeTar(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    if (name.length > 100) {
      const longName = encoder.encode(`${name}\0`);
      parts.push(header('././@LongLink', longName.length, 'L'), pad(longName));
    }
    parts.push(header(name, data.length), pad(data));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal valid build artifact like the managed workflow produces. */
export function artifactFiles(overrides: Record<string, string | null> = {}): Record<string, string> {
  const files: Record<string, string | null> = {
    './dist/app/wrangler.json': JSON.stringify({
      name: 'app',
      main: 'index.js',
      compatibility_date: '2026-08-22',
      compatibility_flags: ['nodejs_compat'],
      assets: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], directory: '../client' },
      vars: { GREETING: 'hi' },
    }),
    './dist/app/index.js': 'const app = { fetch() { return new Response("ok"); } };\nexport { app as default };\n',
    './dist/app/chunk.js': 'export const x = 1;\n',
    './dist/app/.vite/manifest.json': '{}',
    './dist/client/index.html': '<!doctype html><div id="root"></div>',
    './dist/client/assets/app.js': 'console.log(1)',
    './migrations/0001_init.sql':
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\nINSERT INTO notes (body) VALUES ('hello');",
    './manifest.json': '{"commit_sha":"x"}',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) as Record<string, string>;
}
