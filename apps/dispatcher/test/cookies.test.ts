import { describe, expect, it } from 'vitest';
import { filterCookieHeader, isolateRequest, isolateResponse, isolateSetCookie } from '../src/cookies';

describe('cookie isolation (RUN-5)', () => {
  it.each([
    ['sid=abc', '__Host-sid=abc; Path=/; Secure'],
    ['sid=abc; Domain=motad.app; Path=/api; HttpOnly', '__Host-sid=abc; HttpOnly; Path=/; Secure'],
    [
      'sid=abc; domain=.motad.app; SECURE; SameSite=Lax; Max-Age=60',
      '__Host-sid=abc; SameSite=Lax; Max-Age=60; Path=/; Secure',
    ],
    [
      'sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      '__Host-sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure',
    ],
    ['token=a=b=c; Path=/', '__Host-token=a=b=c; Path=/; Secure'],
    ['__Host-sid=abc; Path=/; Secure', '__Host-__Host-sid=abc; Path=/; Secure'],
  ])('rewrites %s (RUN-5.1)', (input, output) => {
    expect(isolateSetCookie(input)).toBe(output);
  });

  it('forwards only prefixed cookies, prefix removed once (RUN-5.2)', () => {
    expect(filterCookieHeader('__Host-sid=abc; evil=1; __Host-__Host-x=2; theme=dark')).toBe('sid=abc; __Host-x=2');
    expect(filterCookieHeader('evil=1')).toBeNull();
    expect(filterCookieHeader(null)).toBeNull();
  });

  it('strips cookies from same-site requests only (RUN-5.3)', () => {
    const request = (site?: string) =>
      new Request('https://todo.motad.app/api', {
        headers: { cookie: '__Host-sid=abc; planted=1', ...(site ? { 'sec-fetch-site': site } : {}) },
      });
    expect(isolateRequest(request('same-site')).headers.get('cookie')).toBeNull();
    for (const site of ['same-origin', 'cross-site', 'none', undefined]) {
      expect(isolateRequest(request(site)).headers.get('cookie')).toBe('sid=abc');
    }
    expect(
      isolateRequest(new Request('https://todo.motad.app/', { headers: { cookie: 'planted=1' } })).headers.has(
        'cookie',
      ),
    ).toBe(false);
  });

  it('keeps method, body and other headers of the request', async () => {
    const original = new Request('https://todo.motad.app/api', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', cookie: '__Host-sid=abc' },
    });
    const isolated = isolateRequest(original);
    expect(isolated.method).toBe('POST');
    expect(isolated.headers.get('content-type')).toBe('application/json');
    expect(await isolated.text()).toBe('{"a":1}');
  });

  it('rewrites every Set-Cookie and adds Origin-Agent-Cluster (RUN-5.1, RUN-5.4)', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'a=1; Domain=motad.app');
    headers.append('set-cookie', 'b=2; Path=/x');
    const response = isolateResponse(new Response('ok', { status: 201, headers }));
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(['__Host-a=1; Path=/; Secure', '__Host-b=2; Path=/; Secure']);
    expect(response.headers.get('origin-agent-cluster')).toBe('?1');
    expect(isolateResponse(new Response('ok')).headers.getSetCookie()).toEqual([]);
  });
});
