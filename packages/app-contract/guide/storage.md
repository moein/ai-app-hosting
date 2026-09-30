# Storage

Every app has its own **R2** bucket for files (uploads, exports, generated images — anything too big or too binary for the database), available as `env.FILES`, a standard Workers `R2Bucket`. There is no size limit imposed by the platform beyond what R2 itself supports.

## Reading and writing from code

```ts
// upload
await c.env.FILES.put(key, data, { httpMetadata: { contentType } });

// download (stream the body straight back)
const object = await c.env.FILES.get(key);
if (!object) return c.notFound();
return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } });

// delete
await c.env.FILES.delete(key);
```

Also available: `head(key)` (metadata only) and `list({ prefix, cursor })` (paginated).

## Buckets are never public

There is no public URL for `env.FILES` — every read goes through your own API route, so you control access. A typical pattern:

```ts
app.get('/api/files/:key', async (c) => {
  const key = c.req.param('key');
  // check whatever access control this route needs (ownership, a session, …) before serving it
  const object = await c.env.FILES.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } });
});
```

## Choosing keys, and tracking uploads

The key is any string you choose — there's no forced structure. If the app needs to list or query uploads by owner (e.g. "this user's files"), store the key alongside whatever metadata you need in **D1** (the `database` topic) rather than relying on `list()` for anything beyond debugging; `env.DB` is much better at filtering and joining than listing R2 keys by prefix.

## Inspecting stored files

`list_storage_objects({ app, prefix?, cursor? })` lists keys, sizes and upload times in the app's bucket — not their contents — up to {{MAX_STORAGE_LIST_KEYS}} per call, with a `cursor` for more. Use it to debug an upload feature (e.g. "did this file actually get written?") without writing throwaway inspection code.
