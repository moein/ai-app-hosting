import { PlatformError } from '@repo/shared';
import { z } from 'zod';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const LIMIT = 10_000;

export type AssetsUsage = { hostname: string; requests: number };
export type D1Usage = { databaseId: string; rowsRead: number; rowsWritten: number };
export type D1Storage = { databaseId: string; bytes: number };
export type R2Storage = { bucketName: string; bytes: number };
export type R2Operations = { bucketName: string; classA: number; classB: number };

/**
 * Per-day usage from the Cloudflare GraphQL Analytics API (spec 13). One query per dataset per day. Worker
 * invocations aren't here: GraphQL reports Workers for Platforms user scripts as `__unknown__`, so the tail worker
 * counts them instead.
 */
export interface CloudflareAnalyticsClient {
  assets(day: string): Promise<AssetsUsage[]>;
  d1(day: string): Promise<D1Usage[]>;
  d1Storage(day: string): Promise<D1Storage[]>;
  /** The app's own R2 bucket (spec 15), keyed by `bucketName` (matched to `apps.r2_bucket_name`). */
  r2Storage(day: string): Promise<R2Storage[]>;
  /** Class A (writes/lists) and Class B (reads) operation counts; see `R2_CLASS_A_ACTIONS`/`R2_CLASS_B_ACTIONS`. */
  r2Operations(day: string): Promise<R2Operations[]>;
}

/**
 * R2's `actionType` dimension has no "class" field — Cloudflare bills by these fixed lists (pricing docs).
 * Deletes (`DeleteBucket`, `DeleteObject`, `DeleteObjects`, `AbortMultipartUpload`) are free and counted in
 * neither. Confirmed against the real schema and real recorded `actionType` values (spec 15 task 6).
 */
export const R2_CLASS_A_ACTIONS = [
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'UploadPart',
  'UploadPartCopy',
  'ListMultipartUploads',
  'ListParts',
  'PutBucketCors',
  'PutBucketEncryption',
  'PutBucketLifecycleConfiguration',
  'PutBucketPublicAccessBlock',
  'PutBucketStorageClass',
  'PutObjectMetadata',
];
export const R2_CLASS_B_ACTIONS = [
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'GetObjectMetadata',
  'GetBucketCors',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketLifecycleConfiguration',
  'GetBucketPublicAccessBlock',
];

const num = z.coerce.number().catch(0);
const Envelope = z.object({
  data: z
    .object({ viewer: z.object({ accounts: z.array(z.record(z.string(), z.unknown())) }) })
    .nullable()
    .optional(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});
const AssetRows = z.array(
  z.object({ dimensions: z.object({ hostname: z.string() }), sum: z.object({ requests: num }) }),
);
const D1Rows = z.array(
  z.object({ dimensions: z.object({ databaseId: z.string() }), sum: z.object({ rowsRead: num, rowsWritten: num }) }),
);
const D1StorageRows = z.array(
  z.object({ dimensions: z.object({ databaseId: z.string() }), max: z.object({ databaseSizeBytes: num }) }),
);
const R2StorageRows = z.array(
  z.object({ dimensions: z.object({ bucketName: z.string() }), max: z.object({ payloadSize: num }) }),
);
const R2OpRows = z.array(
  z.object({ dimensions: z.object({ bucketName: z.string() }), sum: z.object({ requests: num }) }),
);
const R2OperationsEnvelope = z.object({ classA: R2OpRows, classB: R2OpRows });

export const QUERIES = {
  assets: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: workersAssetsRequestsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { hostname } sum { requests } } } } }`,
  d1: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: d1AnalyticsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { databaseId } sum { rowsRead rowsWritten } } } } }`,
  d1Storage: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: d1StorageAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { databaseId } max { databaseSizeBytes } } } } }`,
  r2Storage: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: r2StorageAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { bucketName } max { payloadSize } } } } }`,
  r2Operations: `query($account: String!, $day: Date!, $classA: [string!], $classB: [string!]) {
    viewer { accounts(filter: { accountTag: $account }) {
      classA: r2OperationsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day, actionType_in: $classA }) {
        dimensions { bucketName } sum { requests } }
      classB: r2OperationsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day, actionType_in: $classB }) {
        dimensions { bucketName } sum { requests } } } } }`,
};

export function createCloudflareAnalyticsClient(options: {
  apiToken: string;
  accountId: string;
  fetch?: typeof fetch;
}): CloudflareAnalyticsClient {
  const fetchImpl = options.fetch ?? fetch;

  /** The raw `accounts[0]` object — usually just `{ rows }`, but `r2Operations` aliases two groups on it. */
  async function account(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(GRAPHQL, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { account: options.accountId, ...variables } }),
      });
    } catch (error) {
      throw new PlatformError('UPSTREAM_ERROR', { message: 'Could not reach Cloudflare analytics.', cause: error });
    }
    const envelope = Envelope.safeParse(await response.json().catch(() => null));
    const errors = envelope.success ? (envelope.data.errors ?? []) : [];
    if (!response.ok || !envelope.success || errors.length > 0 || !envelope.data.data) {
      throw new PlatformError('UPSTREAM_ERROR', {
        message: `Cloudflare analytics failed: ${errors.map((e) => e.message).join('; ') || response.status}`,
        details: { status: response.status },
      });
    }
    return envelope.data.data.viewer.accounts[0] ?? {};
  }

  const rows = async (query: string, variables: Record<string, string>): Promise<unknown> =>
    (await account(query, variables)).rows ?? [];

  return {
    async assets(day) {
      return AssetRows.parse(await rows(QUERIES.assets, { day })).map((r) => ({
        hostname: r.dimensions.hostname,
        requests: r.sum.requests,
      }));
    },
    async d1(day) {
      return D1Rows.parse(await rows(QUERIES.d1, { day })).map((r) => ({
        databaseId: r.dimensions.databaseId,
        rowsRead: r.sum.rowsRead,
        rowsWritten: r.sum.rowsWritten,
      }));
    },
    async d1Storage(day) {
      return D1StorageRows.parse(await rows(QUERIES.d1Storage, { day })).map((r) => ({
        databaseId: r.dimensions.databaseId,
        bytes: r.max.databaseSizeBytes,
      }));
    },
    async r2Storage(day) {
      return R2StorageRows.parse(await rows(QUERIES.r2Storage, { day })).map((r) => ({
        bucketName: r.dimensions.bucketName,
        bytes: r.max.payloadSize,
      }));
    },
    async r2Operations(day) {
      const acc = await account(QUERIES.r2Operations, { day, classA: R2_CLASS_A_ACTIONS, classB: R2_CLASS_B_ACTIONS });
      const { classA, classB } = R2OperationsEnvelope.parse(acc);
      const byBucket = new Map<string, R2Operations>();
      const get = (bucketName: string) => {
        let entry = byBucket.get(bucketName);
        if (!entry) {
          entry = { bucketName, classA: 0, classB: 0 };
          byBucket.set(bucketName, entry);
        }
        return entry;
      };
      for (const r of classA) get(r.dimensions.bucketName).classA += r.sum.requests;
      for (const r of classB) get(r.dimensions.bucketName).classB += r.sum.requests;
      return [...byBucket.values()];
    },
  };
}
