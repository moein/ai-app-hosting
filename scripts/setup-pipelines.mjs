#!/usr/bin/env node
// Event and runtime-log archives (spec 05 task 1, spec 10 LOG-2.6): per dataset a stream (with schema), an R2 Data
// Catalog sink (Iceberg table in datalake-<env>, namespace `platform`) and the pipeline between them. Idempotent.
// Usage: node scripts/setup-pipelines.mjs <dev|prod>   — prints the stream ids for the wrangler.jsonc bindings.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonc } from '../packages/app-contract/src/jsonc.ts';
import { readEnvFile } from './env-file.mjs';

const env = process.argv[2];
if (env !== 'dev' && env !== 'prod') {
  process.stderr.write('usage: node scripts/setup-pipelines.mjs <dev|prod>\n');
  process.exit(2);
}
const say = (line) => process.stdout.write(`${line}\n`);
const accountId = parseJsonc(readFileSync('apps/api/wrangler.jsonc', 'utf8')).account_id;
const token = readEnvFile(env).CF_API_TOKEN; // needs R2 Data Catalog + R2 Storage write; passed to the sink, never printed
const bucket = `datalake-${env}`;
const DATASETS = [
  { table: 'mcp_events', schema: 'scripts/pipelines/mcp_events.schema.json', binding: 'api EVENTS' },
  { table: 'app_logs', schema: 'scripts/pipelines/app_logs.schema.json', binding: 'tail LOG_ARCHIVE' },
];

// Every wrangler failure is reported with the token redacted: the catalog token is a command-line argument,
// and pnpm echoes the failing command.
const redact = (text) => String(text ?? '').replaceAll(token, '<redacted>');
const wrangler = (args, { json = false } = {}) => {
  let out;
  try {
    out = execFileSync('pnpm', ['-F', '@repo/api', 'exec', 'wrangler', ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = /ERROR[^\n]*\n?[^\n]*/.exec(redact(error.stderr))?.[0] ?? 'see wrangler logs';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes is the point
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed: ${detail.replace(/\x1B\[[0-9;]*m/g, '')}`);
  }
  // wrangler may print a [WARNING] banner first; the JSON starts at the first line that opens with [ or {.
  return json ? JSON.parse(out.slice(out.search(/^[[{]/m))) : out;
};
const listArgs = (kind) => [
  ...(kind === 'pipelines' ? ['pipelines', 'list'] : ['pipelines', kind, 'list']),
  '--json',
  '--per-page',
  '100',
];
// `sinks list --json` prints a JS object dump rather than JSON, so names are matched in either format.
const names = (kind) =>
  [...wrangler(listArgs(kind)).matchAll(/["']?name["']?\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
const list = (kind) => names(kind).map((name) => ({ name }));
const streamId = (name) => wrangler(listArgs('streams'), { json: true }).find((s) => s.name === name)?.id;

process.on('uncaughtException', (error) => {
  process.stderr.write(`${redact(error.message)}\n`);
  process.exit(1);
});

try {
  wrangler(['r2', 'bucket', 'create', bucket]);
  say(`bucket ${bucket}: created`);
} catch {
  say(`bucket ${bucket}: exists`);
}
wrangler(['r2', 'bucket', 'catalog', 'enable', bucket]);

for (const { table, schema, binding } of DATASETS) {
  const stream = `${table}_${env}`;
  const sink = `${table}_${env}_sink`;
  if (!list('streams').some((s) => s.name === stream)) {
    wrangler(['pipelines', 'streams', 'create', stream, '--schema-file', resolve(schema), '--http-enabled', 'false']);
    say(`stream ${stream}: created`);
  }
  if (!list('sinks').some((s) => s.name === sink)) {
    wrangler([
      'pipelines',
      'sinks',
      'create',
      sink,
      '--type',
      'r2-data-catalog',
      '--bucket',
      bucket,
      '--namespace',
      'platform',
      '--table',
      table,
      '--catalog-token',
      token,
      '--roll-interval',
      '60',
    ]);
    say(`sink ${sink}: created`);
  }
  if (!list('pipelines').some((p) => p.name === stream)) {
    wrangler(['pipelines', 'create', stream, '--sql', `INSERT INTO ${sink} SELECT * FROM ${stream}`]);
    say(`pipeline ${stream}: created`);
  }
  const id = streamId(stream);
  say(`${binding} → { "binding": "${binding.split(' ')[1]}", "stream": "${id}" }`);
}
