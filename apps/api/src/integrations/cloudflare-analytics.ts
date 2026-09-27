import { PlatformError } from '@repo/shared';
import { z } from 'zod';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const LIMIT = 10_000;

export type WorkersUsage = { scriptName: string; requests: number; cpuMs: number; subrequests: number };
export type AssetsUsage = { hostname: string; requests: number };
export type D1Usage = { databaseId: string; rowsRead: number; rowsWritten: number };
export type D1Storage = { databaseId: string; bytes: number };

/** Per-day usage from the Cloudflare GraphQL Analytics API (spec 13). One query per dataset per day. */
export interface CloudflareAnalyticsClient {
  workers(dispatchNamespace: string, day: string): Promise<WorkersUsage[]>;
  assets(day: string): Promise<AssetsUsage[]>;
  d1(day: string): Promise<D1Usage[]>;
  d1Storage(day: string): Promise<D1Storage[]>;
}

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
const WorkersRows = z.array(
  z.object({
    dimensions: z.object({ scriptName: z.string() }),
    sum: z.object({ requests: num, cpuTimeUs: num, subrequests: num }),
  }),
);
const AssetRows = z.array(
  z.object({ dimensions: z.object({ hostname: z.string() }), sum: z.object({ requests: num }) }),
);
const D1Rows = z.array(
  z.object({ dimensions: z.object({ databaseId: z.string() }), sum: z.object({ rowsRead: num, rowsWritten: num }) }),
);
const D1StorageRows = z.array(
  z.object({ dimensions: z.object({ databaseId: z.string() }), max: z.object({ databaseSizeBytes: num }) }),
);

export const QUERIES = {
  workers: `query($account: String!, $day: Date!, $namespace: String!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: workersInvocationsAdaptive(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day, dispatchNamespaceName: $namespace }) {
      dimensions { scriptName } sum { requests cpuTimeUs subrequests } } } } }`,
  assets: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: workersAssetsRequestsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { hostname } sum { requests } } } } }`,
  d1: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: d1AnalyticsAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { databaseId } sum { rowsRead rowsWritten } } } } }`,
  d1Storage: `query($account: String!, $day: Date!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: d1StorageAdaptiveGroups(limit: ${LIMIT}, filter: { date_geq: $day, date_leq: $day }) {
      dimensions { databaseId } max { databaseSizeBytes } } } } }`,
};

export function createCloudflareAnalyticsClient(options: {
  apiToken: string;
  accountId: string;
  fetch?: typeof fetch;
}): CloudflareAnalyticsClient {
  const fetchImpl = options.fetch ?? fetch;

  async function rows(query: string, variables: Record<string, string>): Promise<unknown> {
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
    return envelope.data.data.viewer.accounts[0]?.rows ?? [];
  }

  return {
    async workers(namespace, day) {
      return WorkersRows.parse(await rows(QUERIES.workers, { day, namespace })).map((r) => ({
        scriptName: r.dimensions.scriptName,
        requests: r.sum.requests,
        cpuMs: r.sum.cpuTimeUs / 1000,
        subrequests: r.sum.subrequests,
      }));
    },
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
  };
}
