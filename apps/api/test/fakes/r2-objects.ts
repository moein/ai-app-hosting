import type { R2ObjectClient } from '../../src/integrations/r2-objects';

type StoredObject = { key: string; size: number; uploadedAt: string; etag: string };

/** In-memory R2 objects, keyed by bucket. `put` is test-only (no real client method needs it yet). */
export function fakeR2Objects() {
  const buckets = new Map<string, Map<string, StoredObject>>();
  const failures = new Map<keyof R2ObjectClient, Error>();

  const bucketOf = (name: string) => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
    }
    return bucket;
  };
  const fail = (method: keyof R2ObjectClient) => {
    const error = failures.get(method);
    if (error) throw error;
  };

  const client: R2ObjectClient = {
    async list(bucketName, options = {}) {
      fail('list');
      const objects = [...bucketOf(bucketName).values()]
        .filter((o) => !options.prefix || o.key.startsWith(options.prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const limit = options.limit ?? 1000;
      const start = options.cursor ? Number(options.cursor) : 0;
      const page = objects.slice(start, start + limit);
      const truncated = start + limit < objects.length;
      return { objects: page, cursor: truncated ? String(start + limit) : null, truncated };
    },
    async deleteAll(bucketName, keys) {
      fail('deleteAll');
      const bucket = bucketOf(bucketName);
      for (const key of keys) bucket.delete(key);
    },
  };

  return {
    client,
    put: (bucketName: string, object: StoredObject) => bucketOf(bucketName).set(object.key, object),
    buckets,
    failNext: (method: keyof R2ObjectClient, error: Error) => failures.set(method, error),
    clearFailures: () => failures.clear(),
  };
}
