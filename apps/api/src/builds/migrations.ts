import { PlatformError } from '@repo/shared';
import type { CloudflareClient } from '../integrations/cloudflare';

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const failed = (file: string, message: string) =>
  new PlatformError('MIGRATION_FAILED', {
    message: `Migration ${file} failed: ${message}`,
    details: { file, message },
  });

/**
 * Applies not-yet-applied migrations in filename order and records name + SHA-256 in `_platform_migrations`
 * (DEP-2.7). An edited applied migration or a failing statement stops everything with MIGRATION_FAILED (DEP-2.8).
 */
export async function applyMigrations(
  cloudflare: CloudflareClient,
  databaseId: string,
  migrations: { name: string; sql: string }[],
  now: number,
): Promise<{ applied: string[] }> {
  await cloudflare.d1Query(
    databaseId,
    'CREATE TABLE IF NOT EXISTS _platform_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const [existing] = await cloudflare.d1Query(databaseId, 'SELECT name, sha256 FROM _platform_migrations');
  const applied = new Map((existing?.rows ?? []).map((row) => [String(row[0]), String(row[1])]));

  const done: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const hash = await sha256(migration.sql);
    const previous = applied.get(migration.name);
    if (previous !== undefined) {
      if (previous !== hash)
        throw failed(migration.name, 'it was edited after being applied; add a new migration instead');
      continue;
    }
    try {
      await cloudflare.d1Query(databaseId, migration.sql);
    } catch (error) {
      throw failed(migration.name, error instanceof Error ? error.message : String(error));
    }
    await cloudflare.d1Query(
      databaseId,
      'INSERT INTO _platform_migrations (name, sha256, applied_at) VALUES (?, ?, ?)',
      [migration.name, hash, now],
    );
    done.push(migration.name);
  }
  return { applied: done };
}
