// Test-only fixture (spec 06, CON-5): the platform's own tests write these files into a dev app to exercise
// build and deploy end to end. It is never given to users.
import { Hono } from 'hono';
import type { Env } from './env';

const app = new Hono<{ Bindings: Env }>();

// Let unexpected errors escape so the runtime records them as exceptions (F-LOG-1).
app.onError((error) => {
  throw error;
});

/** DB binding works and migrations ran (F-DEP-1). */
app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS notes FROM notes').first<{ notes: number }>();
  return c.json({ ok: true, notes: row?.notes ?? 0 });
});

/** SHA-256 of a secret, never the value (F-RUN-1). */
app.get('/api/secret-hash', async (c) => {
  const value = (c.env as unknown as Record<string, unknown>)[c.req.query('name') ?? ''];
  if (typeof value !== 'string') return c.json({ hash: null });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return c.json({ hash: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') });
});

/** Console output and an optional exception, for runtime logs (F-LOG-1). */
app.post('/api/log', async (c) => {
  const { marker, fail } = await c.req.json<{ marker: string; fail?: boolean }>();
  console.log(`log ${marker}`);
  console.error(`error ${marker}`);
  if (fail) throw new Error(`boom ${marker}`);
  return c.json({ ok: true });
});

/** Stores a file in the app's bucket and reads it back (F-FILE-1). */
app.put('/api/files/:key', async (c) => {
  const key = c.req.param('key');
  await c.env.FILES.put(key, await c.req.arrayBuffer(), {
    httpMetadata: { contentType: c.req.header('content-type') ?? 'application/octet-stream' },
  });
  return c.json({ ok: true, key });
});
app.get('/api/files/:key', async (c) => {
  const object = await c.env.FILES.get(c.req.param('key'));
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
  });
});

/** Tries to set a cookie for the whole domain and echoes the cookies it received (F-RUN-4). */
app.get('/api/cookies', (c) => {
  const parent = new URL(c.req.url).hostname.split('.').slice(1).join('.');
  c.header('set-cookie', `sid=abc; Domain=${parent}; Path=/api; HttpOnly`);
  return c.json({ received: c.req.header('cookie') ?? null });
});

/** Sends an email through the platform binding (F-MAIL-1). */
app.post('/api/send-email', async (c) => {
  const { to, subject } = await c.req.json<{ to: string; subject: string }>();
  return c.json(await c.env.EMAIL.send({ to, subject, text: `Sent by the contract app: ${subject}` }));
});

export default app;
