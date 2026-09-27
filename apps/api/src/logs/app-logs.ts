import type { AppLogsRpc } from '@repo/shared';

/** The app's AppLogBuffer in the tail worker (APP_LOGS is bound with script_name tail-<env>). */
export const appLogsFor = (env: Env, appId: string): AppLogsRpc =>
  env.APP_LOGS.get(env.APP_LOGS.idFromName(appId)) as unknown as AppLogsRpc;
