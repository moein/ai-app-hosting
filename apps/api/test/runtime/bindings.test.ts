import { BEING_BUILT_HTML } from '@repo/http';
import { describe, expect, it } from 'vitest';
import { buildBindings } from '../../src/runtime/bindings';
import { beingBuiltResponse, PLACEHOLDER_MODULE, placeholderMetadata } from '../../src/runtime/placeholder';

const app = { appId: 'app_abc', orgId: 'org_def', slug: 'todo', d1DatabaseId: 'db-1', r2BucketName: 'app-todo-dev' };

describe('app script bindings (RUN-2.1, RUN-2.2)', () => {
  it('are exactly DB, FILES, ASSETS, EMAIL (with platform props) and string vars', () => {
    expect(buildBindings(app, { environment: 'dev', assets: true, vars: { GREETING: 'hi' } })).toEqual([
      { type: 'd1', name: 'DB', id: 'db-1' },
      { type: 'r2_bucket', name: 'FILES', bucket_name: 'app-todo-dev' },
      { type: 'assets', name: 'ASSETS' },
      {
        type: 'service',
        name: 'EMAIL',
        service: 'email-dev',
        entrypoint: 'AppMail',
        props: { appId: 'app_abc', orgId: 'org_def', slug: 'todo' },
      },
      { type: 'plain_text', name: 'GREETING', text: 'hi' },
    ]);
  });

  it('never include platform resources', () => {
    const names = buildBindings(app, { environment: 'prod', assets: true }).map((b) => b.name);
    expect(names).toEqual(['DB', 'FILES', 'ASSETS', 'EMAIL']);
  });
});

describe('placeholder script (RUN-2.4)', () => {
  it('has no bindings and keeps secrets', () => {
    expect(placeholderMetadata('2026-08-22')).toEqual({
      main_module: 'placeholder.mjs',
      compatibility_date: '2026-08-22',
      bindings: [],
      keep_bindings: ['secret_text'],
    });
  });

  it('serves the 503 "being built" page', async () => {
    const res = beingBuiltResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).toBe(BEING_BUILT_HTML);
    // the uploaded module returns exactly the same page and status
    const module = String(PLACEHOLDER_MODULE.content);
    expect(module).toContain(JSON.stringify(BEING_BUILT_HTML));
    expect(module).toContain('"status":503');
  });
});
