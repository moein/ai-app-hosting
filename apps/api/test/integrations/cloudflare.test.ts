import type { PlatformError } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareClient } from '../../src/integrations/cloudflare';

const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
const setup = (...responses: (Response | Error)[]) => {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? ok(null);
  });
  const client = createCloudflareClient({
    apiToken: 'tok',
    accountId: 'acc',
    dispatchNamespace: 'apps-dev',
    fetch: fetchImpl as unknown as typeof fetch,
  });
  const call = (i = 0) => fetchImpl.mock.calls[i] as unknown as [string, RequestInit];
  return { client, call };
};

describe('CloudflareClient (spec 09 design)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates and finds D1 databases', async () => {
    const { client, call } = setup(ok({ uuid: 'db-1' }), ok([{ uuid: 'db-2', name: 'app-x-dev' }]));
    expect(await client.createD1('app-todo-dev')).toEqual({ id: 'db-1' });
    expect(call(0)[0]).toBe('https://api.cloudflare.com/client/v4/accounts/acc/d1/database');
    expect(JSON.parse(String(call(0)[1].body))).toEqual({ name: 'app-todo-dev' });
    expect(call(0)[1].headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(await client.findD1('app-x-dev')).toEqual({ id: 'db-2' });
    expect(call(1)[0]).toContain('/d1/database?name=app-x-dev');
  });

  it('runs raw D1 queries', async () => {
    const meta = { rows_read: 1, rows_written: 0, duration: 0.2 };
    const { client, call } = setup(ok([{ results: { columns: ['one'], rows: [[1]] }, meta }]));
    expect(await client.d1Query('db-1', 'SELECT ? AS one', [1])).toEqual([{ columns: ['one'], rows: [[1]], meta }]);
    expect(call()[0]).toContain('/d1/database/db-1/raw');
    expect(JSON.parse(String(call()[1].body))).toEqual({ sql: 'SELECT ? AS one', params: [1] });
  });

  it('uploads scripts as multipart with metadata and modules', async () => {
    const { client, call } = setup(ok({ id: 'todo' }));
    await client.uploadScript('todo', { main_module: 'index.js', compatibility_date: '2026-08-22', bindings: [] }, [
      { name: 'index.js', type: 'esm', content: 'export default {}' },
    ]);
    const [url, init] = call();
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/workers/dispatch/namespaces/apps-dev/scripts/todo',
    );
    expect(init.method).toBe('PUT');
    const form = init.body as FormData;
    expect(JSON.parse(await (form.get('metadata') as Blob).text())).toMatchObject({ main_module: 'index.js' });
    const module = form.get('index.js') as File;
    expect(module.type).toBe('application/javascript+module');
    expect(await module.text()).toBe('export default {}');
  });

  it('treats 404 on delete as already gone', async () => {
    const { client } = setup(new Response('{}', { status: 404 }), ok(null));
    expect(await client.deleteScript('gone')).toBe('not_found');
    expect(await client.deleteScript('todo')).toBe('deleted');
  });

  it('sets secrets as secret_text and uploads assets with the upload JWT', async () => {
    const { client, call } = setup(ok(null), ok({ jwt: 'done' }));
    await client.putSecret('todo', 'API_KEY', 'value');
    expect(JSON.parse(String(call(0)[1].body))).toEqual({ name: 'API_KEY', text: 'value', type: 'secret_text' });
    expect(await client.uploadAssetBucket('upload-jwt', { abc: 'aGk=' })).toEqual({ jwt: 'done' });
    expect(call(1)[0]).toContain('/workers/assets/upload?base64=true');
    expect(call(1)[1].headers).toMatchObject({ authorization: 'Bearer upload-jwt' });
  });

  it('maps 429/5xx/network errors to retryable UPSTREAM_ERROR and logs 4xx rejections', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const response of [
      new Response('{}', { status: 429 }),
      new Response('{}', { status: 502 }),
      new TypeError('down'),
    ]) {
      const { client } = setup(response);
      const error = await client.createD1('x').catch((e: unknown) => e as PlatformError);
      expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    }
    const { client } = setup(
      Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }),
    );
    const error = (await client.createD1('x').catch((e: unknown) => e)) as PlatformError;
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toContain('Authentication error');
  });
});
