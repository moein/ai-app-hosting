import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { handleTail } from '../src/index';
import { traceItem } from './trace';

const APP = 'app_V1StGXR8_Z5';
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
const fakePipeline = (fail = false) => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    async send(records: Record<string, unknown>[]) {
      if (fail) throw new Error('pipeline down');
      sent.push(...records);
    },
  };
};
const appTag = () => `app_${crypto.randomUUID().slice(0, 11)}`;
const read = (appId: string) =>
  env.APP_LOGS.get(env.APP_LOGS.idFromName(appId)).query({ since: 0, until: Number.MAX_SAFE_INTEGER, limit: 200 });

describe('tail handler (LOG-2.1–2.8)', () => {
  it('writes each app its own entries and archives them with app_id (LOG-2.6)', async () => {
    const [a, b] = [appTag(), appTag()];
    const archive = fakePipeline();
    await handleTail(
      [
        traceItem({ scriptTags: [a], logs: [{ timestamp: 1, level: 'log', message: ['hi'] }] }),
        traceItem({ scriptTags: [b] }),
        traceItem({ scriptTags: ['org_only'] }),
      ],
      { ...env, LOG_ARCHIVE: archive } as Env,
      ctx,
    );
    await Promise.all(pending);
    expect((await read(a)).entries).toHaveLength(2);
    expect((await read(b)).entries).toHaveLength(1);
    const day = new Date(1_790_000_000_000).toISOString().slice(0, 10);
    const usage = await env.APP_LOGS.get(env.APP_LOGS.idFromName(a)).usage([day]);
    expect(usage[day]).toMatchObject({ requests: 1, cpu_ms: 2 });
    expect(archive.sent).toHaveLength(3);
    expect(archive.sent.filter((r) => r.app_id === a)).toHaveLength(2);
    expect(archive.sent[0]).toMatchObject({ app_id: a, kind: 'request', path: '/api/notes' });
  });

  it('still writes the buffer when the archive fails, and never throws (LOG-2.8)', async () => {
    const a = appTag();
    await handleTail([traceItem({ scriptTags: [a] })], { ...env, LOG_ARCHIVE: fakePipeline(true) } as Env, ctx);
    await Promise.all(pending);
    expect((await read(a)).entries).toHaveLength(1);

    const broken = {
      get logs(): never {
        throw new Error('malformed');
      },
    } as unknown as TraceItem;
    await expect(
      worker.tail([broken, traceItem({ scriptTags: [APP] })], env, ctx as ExecutionContext),
    ).resolves.toBeUndefined();
    const noBuffer = {
      ...env,
      APP_LOGS: {
        idFromName: () => {
          throw new Error('no DO');
        },
      },
    } as unknown as Env;
    await expect(worker.tail([traceItem()], noBuffer, ctx as ExecutionContext)).resolves.toBeUndefined();
  });

  it('skips archival when LOG_ARCHIVE is not bound', async () => {
    const a = appTag();
    await handleTail([traceItem({ scriptTags: [a] })], env, ctx);
    expect((await read(a)).entries).toHaveLength(1);
  });
});
