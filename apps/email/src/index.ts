import { parseEnv } from './env';

// Skeleton: PlatformMail / AppMail RPC entrypoints and the tenant queue consumer land in spec 11.
// The worker serves no HTTP routes.
export default {
  fetch(_request, env) {
    parseEnv(env);
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
