import { describe, expect, it } from 'vitest';
import { e2eEnv } from '../src/env';
import { flow } from '../src/flows';

describe('foundation', () => {
  it(flow('F-FND-1', 'the dev API /healthz reports ok on dev'), async () => {
    const res = await fetch(new URL('/healthz', e2eEnv().E2E_API_ORIGIN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'api', environment: 'dev' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});
