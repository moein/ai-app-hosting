import { htmlResponse, NO_APP_HTML } from '@repo/http';
import { parseEnv } from './env';
import { type AppRoute, routeRequest } from './route';

export default {
  async fetch(request, env) {
    let config: ReturnType<typeof parseEnv>;
    try {
      config = parseEnv(env);
    } catch {
      return htmlResponse(NO_APP_HTML, 503);
    }
    return routeRequest(request, {
      appsDomain: config.APPS_DOMAIN,
      platformWebsiteUrl: config.PLATFORM_WEBSITE_URL,
      getRoute: (slug) => env.APP_ROUTES.get<AppRoute>(slug, { type: 'json', cacheTtl: 30 }),
      dispatch: (scriptName, limits) => env.DISPATCHER.get(scriptName, {}, { limits }),
    });
  },
} satisfies ExportedHandler<Env>;
