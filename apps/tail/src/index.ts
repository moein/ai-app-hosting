import { parseEnv } from './env';

// Skeleton: normalization and storage of trace events land in spec 10 (LOG-2).
export default {
  async tail(_events, env) {
    parseEnv(env);
  },
} satisfies ExportedHandler<Env>;
