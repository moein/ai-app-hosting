import { describe, expect, it, vi } from 'vitest';
import { createDnsClient, DnsError } from '../src/integrations/cloudflare-dns';

function cloudflare(existing: { id: string; content: string }[] = []) {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/zones?name=')) return Response.json({ success: true, result: [{ id: 'zone1' }] });
    if (url.includes('/dns_records?')) return Response.json({ success: true, result: existing });
    return Response.json({ success: true, result: {} });
  });
  const dns = createDnsClient({ apiToken: 't', zoneName: 'motad.app', fetch: fetchImpl as typeof fetch });
  return { dns, requests };
}

describe('Cloudflare DNS client (per-app DKIM records)', () => {
  it('creates a DNS-only CNAME in the APPS_DOMAIN zone and caches the zone id', async () => {
    const { dns, requests } = cloudflare();
    expect(await dns.upsertCname('a._domainkey.mail.todo.motad.app', 'a.dkim.amazonses.com')).toBe('created');
    await dns.upsertCname('b._domainkey.mail.todo.motad.app', 'b.dkim.amazonses.com');
    expect(requests.filter((r) => r.url.includes('/zones?name=motad.app'))).toHaveLength(1);
    expect(requests[2]).toEqual({
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/zones/zone1/dns_records',
      body: {
        type: 'CNAME',
        name: 'a._domainkey.mail.todo.motad.app',
        content: 'a.dkim.amazonses.com',
        ttl: 1,
        proxied: false,
      },
    });
  });

  it('leaves an identical record alone and fixes a different one', async () => {
    expect(
      await cloudflare([{ id: 'r1', content: 'a.dkim.amazonses.com' }]).dns.upsertCname(
        'a._domainkey.x',
        'a.dkim.amazonses.com',
      ),
    ).toBe('exists');
    const { dns, requests } = cloudflare([{ id: 'r1', content: 'old' }]);
    expect(await dns.upsertCname('a._domainkey.x', 'a.dkim.amazonses.com')).toBe('updated');
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', url: expect.stringContaining('/dns_records/r1') });
  });

  it('throws DnsError on API failures', async () => {
    const fetchImpl = async () =>
      Response.json({ success: false, errors: [{ message: 'Authentication error' }] }, { status: 403 });
    const dns = createDnsClient({ apiToken: 't', zoneName: 'motad.app', fetch: fetchImpl as typeof fetch });
    await expect(dns.upsertCname('x', 'y')).rejects.toBeInstanceOf(DnsError);
  });
});

describe('Cloudflare DNS client — delete', () => {
  it('deletes every CNAME with the name', async () => {
    const requests: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/zones?name=')) return Response.json({ success: true, result: [{ id: 'zone1' }] });
      if (url.includes('/dns_records?')) return Response.json({ success: true, result: [{ id: 'r1' }] });
      return Response.json({ success: true, result: {} });
    };
    const dns = createDnsClient({ apiToken: 't', zoneName: 'motad.app', fetch: fetchImpl as typeof fetch });
    expect(await dns.deleteCname('a._domainkey.mail.x.motad.app')).toBe(1);
    expect(requests.at(-1)).toBe('DELETE https://api.cloudflare.com/client/v4/zones/zone1/dns_records/r1');
  });
});
