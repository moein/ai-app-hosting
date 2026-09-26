import { parseEnv } from './env';

// Skeleton: routing by hostname lands in spec 09 (RUN-1). Until then every host gets the "no app here" page.
export default {
  fetch(_request, env) {
    parseEnv(env);
    return new Response('There is no app at this address.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
} satisfies ExportedHandler<Env>;
