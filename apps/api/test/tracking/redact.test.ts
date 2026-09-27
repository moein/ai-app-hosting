import { sha256Hex } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from '../../src/mcp/registry';
import { ARGS_MAX_BYTES, REDACTORS, redactArgs, SQL_MAX_CHARS } from '../../src/tracking/redact';

const SENSITIVE = /^(code|value|content|password|token|secret|email)$/i;

function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const item of schema) propertyNames(item, names);
  else if (schema && typeof schema === 'object') {
    const record = schema as Record<string, unknown>;
    if (record.properties && typeof record.properties === 'object') {
      for (const key of Object.keys(record.properties)) names.add(key);
    }
    for (const value of Object.values(record)) propertyNames(value, names);
  }
  return names;
}

describe('argument redaction (EVT-1.4, EVT-1.5, EVT-1.8)', () => {
  it('every tool with a sensitive-looking input field has a redactor', () => {
    const missing = TOOLS.filter((tool) => {
      const names = [...propertyNames(z.toJSONSchema(tool.input, { io: 'input' }))];
      return names.some((name) => SENSITIVE.test(name)) && !REDACTORS[tool.name];
    }).map((tool) => tool.name);
    expect(missing).toEqual([]);
  });

  it('hashes the email of login tools and redacts the code', async () => {
    const hash = await sha256Hex('someone@example.com');
    expect(await redactArgs('request_login_code', { email: ' Someone@Example.com ' })).toEqual({
      argsJson: '{}',
      argsTruncated: false,
      emailHash: hash,
    });
    const verify = await redactArgs('verify_login_code', { email: 'someone@example.com', code: '482913' });
    expect(verify).toEqual({ argsJson: '{"code":"[redacted]"}', argsTruncated: false, emailHash: hash });
  });

  it('redacts secret values and summarizes file contents', async () => {
    const secret = await redactArgs('set_secret', { app: 'todo', name: 'STRIPE_KEY', value: 'sk_live_123' });
    expect(JSON.parse(secret.argsJson ?? '')).toEqual({ app: 'todo', name: 'STRIPE_KEY', value: '[redacted]' });

    const files = await redactArgs('write_files', {
      app: 'todo',
      message: 'init',
      files: [
        { path: 'src/a.ts', content: 'const password = "hunter2";' },
        { path: 'old.ts', op: 'delete' },
      ],
    });
    expect(files.argsJson).not.toContain('hunter2');
    expect(JSON.parse(files.argsJson ?? '').files).toEqual([
      { path: 'src/a.ts', op: 'upsert', bytes: 27, sha256: await sha256Hex('const password = "hunter2";') },
      { path: 'old.ts', op: 'delete' },
    ]);
  });

  it('truncates SQL and caps the whole payload at 8 KB', async () => {
    const sql = await redactArgs('query_database', { app: 'todo', sql: `SELECT ${'x'.repeat(5_000)}` });
    expect(JSON.parse(sql.argsJson ?? '').sql).toHaveLength(SQL_MAX_CHARS);

    const big = await redactArgs('create_app', { name: 'n'.repeat(20_000) });
    expect(big.argsTruncated).toBe(true);
    expect(new TextEncoder().encode(big.argsJson ?? '').byteLength).toBeLessThanOrEqual(ARGS_MAX_BYTES);
    expect(await redactArgs('list_apps', undefined)).toEqual({ argsJson: null, argsTruncated: false, emailHash: null });
  });
});
