/** The Cloudflare DNS operations the email worker needs (per-app DKIM records, spec 11). A fake backs tests. */
export interface DnsClient {
  /** Creates the CNAME (DNS only) unless an identical one exists; returns what it did. */
  upsertCname(name: string, target: string): Promise<'created' | 'exists' | 'updated'>;
  /** Deletes every CNAME with this name; returns how many there were. */
  deleteCname(name: string): Promise<number>;
}

export class DnsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DnsError';
  }
}

type Envelope<T> = { success: boolean; result: T; errors?: { message: string }[] };
const API = 'https://api.cloudflare.com/client/v4';

export function createDnsClient(options: { apiToken: string; zoneName: string; fetch?: typeof fetch }): DnsClient {
  const fetchImpl = options.fetch ?? fetch;
  let zoneId: Promise<string> | undefined;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = (await response.json().catch(() => ({ success: false }))) as Envelope<T>;
    if (!response.ok || !envelope.success) {
      throw new DnsError(
        response.status,
        envelope.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`,
      );
    }
    return envelope.result;
  }

  const zone = () => {
    zoneId ??= call<{ id: string }[]>('GET', `/zones?name=${encodeURIComponent(options.zoneName)}`)
      .then(([found]) => {
        if (!found) throw new DnsError(404, `zone ${options.zoneName} not found`);
        return found.id;
      })
      .catch((error: unknown) => {
        zoneId = undefined;
        throw error;
      });
    return zoneId;
  };

  return {
    async upsertCname(name, target) {
      const id = await zone();
      const records = await call<{ id: string; content: string }[]>(
        'GET',
        `/zones/${id}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
      );
      const record = { type: 'CNAME', name, content: target, ttl: 1, proxied: false };
      const [existing] = records;
      if (existing?.content === target) return 'exists';
      if (existing) {
        await call('PATCH', `/zones/${id}/dns_records/${existing.id}`, record);
        return 'updated';
      }
      await call('POST', `/zones/${id}/dns_records`, record);
      return 'created';
    },
    async deleteCname(name) {
      const id = await zone();
      const records = await call<{ id: string }[]>(
        'GET',
        `/zones/${id}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
      );
      for (const record of records) await call('DELETE', `/zones/${id}/dns_records/${record.id}`);
      return records.length;
    },
  };
}
