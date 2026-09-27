import type { AssetManifest } from '../integrations/cloudflare';
import { toBase64 } from '../integrations/github';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

export const contentTypeFor = (path: string) =>
  MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Content address of an asset: first 32 hex chars of SHA-256(base64 content + extension). */
export async function assetHash(path: string, base64: string): Promise<string> {
  const extension = path.includes('.') ? (path.split('.').pop() ?? '') : '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64 + extension));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export type PreparedAssets = {
  manifest: AssetManifest;
  byHash: Map<string, { base64: string; contentType: string }>;
};

export async function prepareAssets(assets: Map<string, Uint8Array>): Promise<PreparedAssets> {
  const manifest: AssetManifest = {};
  const byHash = new Map<string, { base64: string; contentType: string }>();
  for (const [path, bytes] of assets) {
    const base64 = toBase64(bytes);
    const hash = await assetHash(path, base64);
    manifest[path] = { hash, size: bytes.byteLength };
    byHash.set(hash, { base64, contentType: contentTypeFor(path) });
  }
  return { manifest, byHash };
}
