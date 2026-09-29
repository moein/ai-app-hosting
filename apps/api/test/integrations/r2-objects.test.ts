import { describe, expect, it, vi } from 'vitest';
import { createR2ObjectClient, R2ObjectError } from '../../src/integrations/r2-objects';

function client(respond: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req.clone());
    return respond(req);
  });
  const r2 = createR2ObjectClient({
    accountId: 'acct123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    fetch: fetchImpl as typeof fetch,
  });
  return { r2, requests };
}

const listXml = (opts: { truncated?: boolean; cursor?: string; objects?: { key: string; size: number }[] } = {}) => `
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>
  ${opts.cursor ? `<NextContinuationToken>${opts.cursor}</NextContinuationToken>` : ''}
  ${(opts.objects ?? [])
    .map(
      (o) =>
        `<Contents><Key>${o.key}</Key><LastModified>2026-09-29T00:00:00.000Z</LastModified><ETag>"abc123"</ETag><Size>${o.size}</Size></Contents>`,
    )
    .join('')}
</ListBucketResult>`;

describe('R2ObjectClient (spec 15 task 3)', () => {
  it('signs list with SigV4 for s3 in region auto and parses the XML page', async () => {
    const { r2, requests } = client(
      () => new Response(listXml({ objects: [{ key: 'uploads/a.png', size: 42 }], truncated: false })),
    );
    const result = await r2.list('app-todo-dev', { prefix: 'uploads/' });
    const req = requests[0] as Request;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/app-todo-dev?list-type=2&prefix=uploads%2F&max-keys=1000',
    );
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(result).toEqual({
      objects: [{ key: 'uploads/a.png', size: 42, uploadedAt: '2026-09-29T00:00:00.000Z', etag: 'abc123' }],
      cursor: null,
      truncated: false,
    });
  });

  it('carries the continuation token and truncated flag when there are more pages', async () => {
    const { r2, requests } = client(() => new Response(listXml({ truncated: true, cursor: 'next-token' })));
    const result = await r2.list('app-todo-dev', { cursor: 'prev-token', limit: 50 });
    expect(result).toEqual({ objects: [], cursor: 'next-token', truncated: true });
    expect(requests[0]?.url).toContain('continuation-token=prev-token');
    expect(requests[0]?.url).toContain('max-keys=50');
  });

  it('sends a bulk delete with every key, XML-escaped', async () => {
    const { r2, requests } = client(() => new Response('<DeleteResult/>'));
    await r2.deleteAll('app-todo-dev', ['a.png', 'weird & <name>.png']);
    const req = requests[0] as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://acct123.r2.cloudflarestorage.com/app-todo-dev/?delete');
    expect(await req.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Delete><Object><Key>a.png</Key></Object><Object><Key>weird &amp; &lt;name&gt;.png</Key></Object></Delete>',
    );
  });

  it('batches deleteAll at 1000 keys per request', async () => {
    const { r2, requests } = client(() => new Response('<DeleteResult/>'));
    const keys = Array.from({ length: 1_500 }, (_, i) => `k${i}`);
    await r2.deleteAll('app-todo-dev', keys);
    expect(requests).toHaveLength(2);
    expect((await requests[0]?.text())?.match(/<Object>/g)).toHaveLength(1000);
    expect((await requests[1]?.text())?.match(/<Object>/g)).toHaveLength(500);
  });

  it.each([
    [429, true],
    [500, true],
    [404, false],
    [403, false],
  ])('maps HTTP %s to R2ObjectError with retryable %s', async (status, retryable) => {
    const { r2 } = client(() => new Response('<Error><Code>X</Code><Message>nope</Message></Error>', { status }));
    const error = await r2.list('b').catch((e) => e);
    expect(error).toBeInstanceOf(R2ObjectError);
    expect(error).toMatchObject({ status, retryable, message: 'nope' });
  });

  it('maps network failures to a retryable R2ObjectError', async () => {
    const { r2 } = client(() => {
      throw new TypeError('network down');
    });
    const error = await r2.deleteAll('b', ['k']).catch((e) => e);
    expect(error).toMatchObject({ status: 0, retryable: true, message: 'network down' });
  });
});
