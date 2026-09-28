/**
 * Cookie isolation between apps that share APPS_DOMAIN (spec 09, RUN-5): apps only ever get host-only
 * `__Host-` cookies, and requests from sibling apps (Sec-Fetch-Site: same-site) carry none.
 */
const PREFIX = '__Host-';
const DROPPED_ATTRIBUTES = new Set(['domain', 'path', 'secure']);

/** RUN-5.1: `name=value; attrs` → `__Host-name=value; attrs (no Domain/Path/Secure); Path=/; Secure`. */
export function isolateSetCookie(header: string): string {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const kept = attributes.filter((attribute) => {
    const name = attribute.split('=')[0]?.trim().toLowerCase() ?? '';
    return attribute !== '' && !DROPPED_ATTRIBUTES.has(name);
  });
  return [`${PREFIX}${pair}`, ...kept, 'Path=/', 'Secure'].join('; ');
}

/** RUN-5.2: keeps only `__Host-` cookies, with one prefix removed; null when none remain. */
export function filterCookieHeader(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(PREFIX))
    .map((pair) => pair.slice(PREFIX.length));
  return kept.length > 0 ? kept.join('; ') : null;
}

/** The request as the app should see it (RUN-5.2, RUN-5.3). */
export function isolateRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  const sameSite = headers.get('sec-fetch-site')?.toLowerCase() === 'same-site';
  const cookie = sameSite ? null : filterCookieHeader(headers.get('cookie'));
  if (cookie === null) headers.delete('cookie');
  else headers.set('cookie', cookie);
  return new Request(request, { headers });
}

/** The app's response with isolated cookies and its own agent cluster (RUN-5.1, RUN-5.4); headers are mutable. */
export function isolateResponse(response: Response): Response {
  const copy = new Response(response.body, response);
  const cookies = copy.headers.getSetCookie();
  if (cookies.length > 0) {
    copy.headers.delete('set-cookie');
    for (const cookie of cookies) copy.headers.append('set-cookie', isolateSetCookie(cookie));
  }
  copy.headers.set('origin-agent-cluster', '?1');
  return copy;
}
