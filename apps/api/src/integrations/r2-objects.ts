import { AwsClient } from 'aws4fetch';

export type R2Object = { key: string; size: number; uploadedAt: string; etag: string };
export type R2ListResult = { objects: R2Object[]; cursor: string | null; truncated: boolean };

/** An R2 S3-compatible API failure. `status` 0 means the request never reached R2 (network error). */
export class R2ObjectError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'R2ObjectError';
  }

  /** Worth retrying later (throttling, R2/S3-side failures, network). */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

/**
 * Object-level R2 operations for the api worker (spec 15): unlike bucket lifecycle
 * (`CloudflareClient.createR2`/`findR2`), Cloudflare's account API has no "list/delete objects in any
 * bucket" endpoint, so this goes through R2's S3-compatible API instead, signed with a separate R2 API
 * token (access key id + secret access key, not `CF_API_TOKEN`). A fake backs tests.
 */
export interface R2ObjectClient {
  list(bucket: string, options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>;
  /** Deletes every key, in batches of up to 1000 (the S3 bulk-delete limit). */
  deleteAll(bucket: string, keys: string[]): Promise<void>;
}

export type R2ObjectClientOptions = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
};

const MAX_DELETE_BATCH = 1000;
const decodeXmlEntities = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const escapeXml = (value: string) =>
  value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const tag = (block: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1];

function parseListResult(xml: string): R2ListResult {
  const objects: R2Object[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (let match = contentsRe.exec(xml); match; match = contentsRe.exec(xml)) {
    const block = match[1] ?? '';
    objects.push({
      key: decodeXmlEntities(tag(block, 'Key') ?? ''),
      size: Number(tag(block, 'Size') ?? '0'),
      uploadedAt: tag(block, 'LastModified') ?? '',
      etag: (tag(block, 'ETag') ?? '').replace(/^"|"$/g, ''),
    });
  }
  const truncated = tag(xml, 'IsTruncated') === 'true';
  return { objects, cursor: truncated ? (tag(xml, 'NextContinuationToken') ?? null) : null, truncated };
}

/** R2's S3-compatible API, SigV4-signed with aws4fetch (region `auto`, service `s3`). */
export function createR2ObjectClient(options: R2ObjectClientOptions): R2ObjectClient {
  const aws = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: 'auto',
    retries: 0,
  });
  const fetchImpl = options.fetch ?? fetch;
  const bucketUrl = (bucket: string) => `https://${options.accountId}.r2.cloudflarestorage.com/${bucket}`;

  async function call(url: string, init: RequestInit): Promise<string> {
    let response: Response;
    try {
      const signed = await aws.sign(url, { ...init, aws: { service: 's3', region: 'auto' } });
      response = await fetchImpl(signed);
    } catch (error) {
      throw new R2ObjectError(0, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new R2ObjectError(
        response.status,
        tag(text, 'Message') ?? (text.slice(0, 500) || `HTTP ${response.status}`),
      );
    }
    return text;
  }

  return {
    async list(bucket, opts = {}) {
      const url = new URL(bucketUrl(bucket));
      url.searchParams.set('list-type', '2');
      if (opts.prefix) url.searchParams.set('prefix', opts.prefix);
      if (opts.cursor) url.searchParams.set('continuation-token', opts.cursor);
      url.searchParams.set('max-keys', String(opts.limit ?? 1000));
      return parseListResult(await call(url.toString(), { method: 'GET' }));
    },
    async deleteAll(bucket, keys) {
      for (let i = 0; i < keys.length; i += MAX_DELETE_BATCH) {
        const batch = keys.slice(i, i + MAX_DELETE_BATCH);
        const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${batch
          .map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
          .join('')}</Delete>`;
        await call(`${bucketUrl(bucket)}/?delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/xml' },
          body,
        });
      }
    },
  };
}
