import type { DnsClient } from '../../src/integrations/cloudflare-dns';

export function fakeDns() {
  const records = new Map<string, string>();
  let failure: Error | null = null;
  const client: DnsClient = {
    async upsertCname(name, target) {
      if (failure) throw failure;
      const existing = records.get(name);
      records.set(name, target);
      return existing === undefined ? 'created' : existing === target ? 'exists' : 'updated';
    },
  };
  return {
    client,
    records,
    fail: (error: Error | null) => {
      failure = error;
    },
  };
}
