import { type LogEntry, Logger } from '@repo/shared';
import { parseEnv } from './env';
import { normalize } from './normalize';

export { AppLogBuffer } from './app-log-buffer';

/** Normalizes trace events of user app scripts into per-app log buffers and the archive (spec 10, LOG-2). */
export async function handleTail(events: TraceItem[], env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) {
  const byApp = new Map<string, LogEntry[]>();
  for (const item of events) {
    try {
      const { appId, entries } = normalize(item);
      if (!appId) {
        Logger.root.warn('trace item without app tag', { scriptName: item.scriptName });
        continue;
      }
      byApp.set(appId, [...(byApp.get(appId) ?? []), ...entries]);
    } catch (error) {
      Logger.root.error('trace item normalization failed', { scriptName: item?.scriptName, error });
    }
  }

  await Promise.all(
    [...byApp].map(async ([appId, entries]) => {
      if (entries.length === 0) return;
      if (env.LOG_ARCHIVE) {
        const archive = env.LOG_ARCHIVE;
        ctx.waitUntil(
          archive
            .send(entries.map((entry) => ({ app_id: appId, ...entry })))
            .catch((error: unknown) => Logger.root.error('log archive send failed', { appId, error })),
        );
      }
      try {
        await env.APP_LOGS.get(env.APP_LOGS.idFromName(appId)).append(entries);
      } catch (error) {
        Logger.root.error('log buffer append failed', { appId, count: entries.length, error });
      }
    }),
  );
}

export default {
  async fetch() {
    return new Response(null, { status: 404 });
  },
  async tail(events, env, ctx) {
    try {
      parseEnv(env);
      await handleTail(events, env, ctx);
    } catch (error) {
      Logger.root.error('tail handler failed', { error }); // LOG-2.8: never throw
    }
  },
} satisfies ExportedHandler<Env>;
