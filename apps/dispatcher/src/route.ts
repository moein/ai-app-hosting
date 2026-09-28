import { APP_ERROR_HTML, BEING_BUILT_HTML, htmlResponse, NO_APP_HTML } from '@repo/http';
import { APP_CPU_MS_PER_REQUEST, APP_SUBREQUESTS_PER_REQUEST, Logger } from '@repo/shared';
import { isolateRequest, isolateResponse } from './cookies';

/** KV value per app slug (spec 09 design), written by the api worker. */
export type AppRoute = { appId: string; scriptName: string; state: 'live' | 'not_deployed' };

export type DispatchLimits = { cpuMs: number; subRequests: number };

export type RouterDeps = {
  appsDomain: string;
  platformWebsiteUrl: string;
  getRoute(slug: string): Promise<AppRoute | null>;
  dispatch(scriptName: string, limits: DispatchLimits): Fetcher;
};

const HSTS = 'max-age=31536000; includeSubDomains';

/** Re-wraps a response so headers are mutable, then adds HSTS (RUN-1.8). */
const withHsts = (response: Response) => {
  const copy = new Response(response.body, response);
  copy.headers.set('strict-transport-security', HSTS);
  return copy;
};

/** Host → app script routing for `<slug>.APPS_DOMAIN` (RUN-1). */
export async function routeRequest(request: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }

  const host = url.hostname.toLowerCase();
  const domain = deps.appsDomain.toLowerCase();

  if (host === domain || host === `www.${domain}`) {
    return deps.platformWebsiteUrl
      ? Response.redirect(deps.platformWebsiteUrl, 302)
      : withHsts(htmlResponse(NO_APP_HTML, 404));
  }
  if (!host.endsWith(`.${domain}`)) return withHsts(htmlResponse(NO_APP_HTML, 404));

  const slug = host.slice(0, -(domain.length + 1));
  if (slug.includes('.')) return withHsts(htmlResponse(NO_APP_HTML, 404));

  const route = await deps.getRoute(slug);
  if (!route) return withHsts(htmlResponse(NO_APP_HTML, 404));
  if (route.state !== 'live') return withHsts(htmlResponse(BEING_BUILT_HTML, 503, { 'retry-after': '30' }));

  try {
    const worker = deps.dispatch(route.scriptName, {
      cpuMs: APP_CPU_MS_PER_REQUEST,
      subRequests: APP_SUBREQUESTS_PER_REQUEST,
    });
    return withHsts(isolateResponse(await worker.fetch(isolateRequest(request))));
  } catch (error) {
    Logger.root.error('dispatch failed', { appId: route.appId, scriptName: route.scriptName, error });
    return withHsts(htmlResponse(APP_ERROR_HTML, 502));
  }
}
