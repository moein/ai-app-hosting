/** Typed context shared by the main app and every route group (FND-8.4). */
export type AppEnv = {
  Bindings: Env;
  Variables: { requestId: string };
};
